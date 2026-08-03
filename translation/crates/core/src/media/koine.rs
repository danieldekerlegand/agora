//! koine's additive layer over OTIO (KMI §4.2) — identity, lineage, knowledge.
//!
//! OTIO addresses media by **location** (`ExternalReference.target_url`) and has no
//! identity model, no lineage model, and no assertion semantics. KMI supplies exactly
//! those three, and this module is where agora implements them — *over* an OTIO document
//! ([`super::otio`]), never in place of one. Nothing here adds a class to OTIO's schema
//! (§4.1): the one part that travels inside the timeline rides OTIO's own extension point,
//! a namespaced `metadata.koine` dict, so a stock OTIO reader opens a koine timeline
//! unchanged.
//!
//! | §4.2 | What it is | Where it lives |
//! |---|---|---|
//! | (a) identity | the clip's media is a **content-addressed KINP asset** — [`AssetId`] | inside the timeline, at `media_reference.metadata.koine.asset` |
//! | (b) lineage | how assets relate across re-encodes/excerpts — [`LineageGraph`] | **outside**: KGP assertions over assets (§3) |
//! | (c) knowledge | what analysis found — [`analysis_assertions`] | **outside**: KGP assertions in the asset's world (§5) |
//! | (d) carriers | `kmi_version` and the [`MediaMap`] of §4.3 | optionally on the `Timeline`'s own `metadata.koine` |
//!
//! # Why (b) and (c) are outside, and why that is what makes them survive
//!
//! A timeline is one node in the asset graph, not its container, and OTIO `Marker`s are
//! free-form annotations with no confidence, no provenance, and no world scoping. So
//! lineage and analysis are KGP assertions — which is also why **no adapter can drop
//! them**: they were never in the document an adapter rewrote. What an adapter *can* drop
//! is (a), because that one *is* in the document (KMI §9.5): a CMX3600 EDL addresses media
//! by path and carries no namespaced metadata, so the asset ids do not come home inside
//! the file. That is precisely the loss the §4.3 media map exists to repair, and
//! [`Timeline::relink`] is the repair — it re-attaches the ids the map already names, and
//! invents none it does not.
//!
//! Everything in this module is pure native Rust over the parsed document: reading an
//! asset id, relinking one, walking lineage, and bridging analysis into KGP need no
//! adapter, and therefore no Python interpreter. Only conversion is OTIO-bound.

use crate::datalog::{AnnotatedFact, Atom, Fact};
use crate::error::Error;
use crate::media::otio::{otio_class, MediaReference, Timeline};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// The `metadata` key everything koine contributes to an OTIO document hangs off — the
/// namespaced extension point of §4.1, so a stock OTIO reader ignores it and this crate
/// adds no class to OTIO's schema.
pub const KOINE_METADATA_KEY: &str = "koine";

/// The KINP `<kind>` of an asset identifier (KINP §3.1). A clip references *bytes*, so
/// nothing else is accepted where §4.2a requires an asset id.
pub const ASSET_KIND: &str = "asset";

/// The relation-registry domain the asset-lineage relations of KMI §3 are registered
/// under. They are KGP assertions like any other, which is what gives them confidence and
/// provenance.
pub const LINEAGE_DOMAIN: &str = "media";

/// The analysis → knowledge bridge's **input** plane (KCB §2.1 port typing, KMI §6):
/// media in.
pub const ANALYSIS_BRIDGE_INPUT_PLANE: &str = "media";

/// The analysis → knowledge bridge's **output** plane: knowledge out. The pair is the
/// cross-plane transform typing exists for (KMI §6 / KCB delta F) — a bridge that produced
/// media-plane output, or free text, would not be a KGP assertion at all.
pub const ANALYSIS_BRIDGE_OUTPUT_PLANE: &str = "knowledge";

// --- (a) identity: the content-addressed asset id ------------------------------------

/// A KINP `asset` identifier: `<namespace>:asset:<algorithm>-<digest>` (KINP §3.2/§6).
///
/// The id **is** the hash of the bytes, which is what makes it identity: the same file
/// ingested twice is one asset, and a re-encode is a *different* asset linked by lineage
/// (§3). Parsing therefore checks that the local part is algorithm-prefixed content
/// addressing and not a name — `mediastore:asset:renaud-approach` is rejected, because an
/// id that is a name cannot be verified against bytes and would let a producer mint
/// identity by assertion.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetId(String);

impl AssetId {
    /// Parse and validate a CURIE as a content-addressed asset id.
    pub fn parse(curie: &str) -> Result<AssetId, Error> {
        let parts: Vec<&str> = curie.split(':').collect();
        let [namespace, kind, local] = parts[..] else {
            return Err(Error::Media(format!(
                "{curie:?} is not a KINP CURIE — an asset id is \
                 <namespace>:{ASSET_KIND}:<algorithm>-<digest> (KINP §3.2)"
            )));
        };
        if !is_namespace(namespace) {
            return Err(Error::Media(format!(
                "{curie:?} has no minting-authority namespace (KINP §3.4)"
            )));
        }
        if kind != ASSET_KIND {
            return Err(Error::Media(format!(
                "a clip's media reference names an {ASSET_KIND}, not a {kind:?} \
                 (KMI §4.2a / KINP §3.1)"
            )));
        }
        let Some((algorithm, digest)) = local.split_once('-') else {
            return Err(Error::Media(format!(
                "asset id {curie:?} is not content-addressed: its local part carries no \
                 hash algorithm prefix (KINP §6 — `blake3-…`, `sha256-…`)"
            )));
        };
        if !is_lower_ident(algorithm) {
            return Err(Error::Media(format!(
                "asset id {curie:?} has no hash algorithm before the digest (KINP §6)"
            )));
        }
        if digest.len() < MIN_DIGEST_LEN
            || !digest
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(Error::Media(format!(
                "asset id {curie:?} is not content-addressed: {digest:?} is not a \
                 lowercase-hex {algorithm} digest (KINP §2/§6 — the id is the hash of the bytes)"
            )));
        }
        Ok(AssetId(curie.to_string()))
    }

    /// The id as its canonical CURIE.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The minting authority (KINP §3.4) — the namespace half.
    pub fn namespace(&self) -> &str {
        self.0.split(':').next().unwrap_or_default()
    }

    /// The local part: `<algorithm>-<digest>`.
    pub fn local_id(&self) -> &str {
        self.0.splitn(3, ':').nth(2).unwrap_or_default()
    }

    /// The hash algorithm the bytes were addressed with (`blake3`, `sha256`, …).
    pub fn hash_algorithm(&self) -> &str {
        self.local_id().split_once('-').map_or("", |(algo, _)| algo)
    }

    /// The digest — the hash of the bytes themselves.
    pub fn digest(&self) -> &str {
        self.local_id().split_once('-').map_or("", |(_, hex)| hex)
    }
}

impl fmt::Display for AssetId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The shortest digest prefix accepted as content addressing. koine's worked examples
/// elide digests, and a producer may publish a prefix, but a two-character "hash" is a
/// name wearing a hash's shape.
const MIN_DIGEST_LEN: usize = 8;

/// `[a-z0-9][a-z0-9._-]*` — a KINP namespace (§3.1).
fn is_namespace(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// `[a-z][a-z0-9]*` — a hash algorithm token or a relation-registry domain.
fn is_lower_ident(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `[a-z][a-z0-9_]*` — a `snake_case` relation name (KGP §3.2 rule 1).
fn is_snake_case(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

impl MediaReference<'_> {
    /// The KINP asset id §4.2a requires this reference to carry, if it has one.
    ///
    /// `None` means the identity is **absent** — a reference that never carried one, or,
    /// far more often, one whose `metadata.koine` a third-party round trip dropped (§9.5).
    /// A malformed id is an error rather than a `None`: silently treating one as missing
    /// is how a bad id becomes a relinked good one and identity is quietly invented.
    pub fn asset(&self) -> Result<Option<AssetId>, Error> {
        let Some(value) = self.koine.and_then(|koine| koine.get(ASSET_KIND)) else {
            return Ok(None);
        };
        let curie = value.as_str().ok_or_else(|| {
            Error::Media(format!(
                "`metadata.koine.asset` must be a KINP asset CURIE, got {value} (KMI §4.2a)"
            ))
        })?;
        AssetId::parse(curie).map(Some)
    }
}

/// One clip media reference, seen through §4.2a: what it plays, where it claims to be, and
/// whether it still knows *which asset* that is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetReference<'a> {
    /// The name of the clip the reference hangs off.
    pub clip: Option<&'a str>,
    /// The `media_references` key (or [`DEFAULT_MEDIA_KEY`](super::DEFAULT_MEDIA_KEY)).
    pub key: &'a str,
    /// The reference's `OTIO_SCHEMA` — `MissingReference.1` is as valid a carrier of an id
    /// as `ExternalReference.1`, since §4.2a requires the id even with no path to offer.
    pub schema: &'a str,
    /// Location — **advisory**, and the only thing an NLE adapter's output preserves.
    pub target_url: Option<&'a str>,
    /// Identity — **authoritative**, and `None` once something has dropped it.
    pub asset: Option<AssetId>,
}

// --- (d) the media map (§4.3, delta I) -----------------------------------------------

/// The asset-id ↔ resolved-path map that must travel with anything handed to a consumer
/// resolving media by path (KMI §4.3, delta I).
///
/// Adapter output addresses media by file path, and OTIO's own `ExternalReference` is
/// `target_url`-based, so without this map every clip goes "media offline" on the far
/// side — and, for koine, the content-addressed identity of §4.2a has nothing to come back
/// from. It MAY ride the canonical timeline at `metadata.koine.media_map` (§4.2d) or
/// travel beside the adapter output; either way it is one entry per referenced asset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaMap {
    entries: BTreeMap<AssetId, String>,
}

impl MediaMap {
    /// An empty map.
    pub fn new() -> MediaMap {
        MediaMap::default()
    }

    /// Record where an asset's bytes resolve, returning any prior location for it.
    pub fn insert(&mut self, asset: AssetId, location: impl Into<String>) -> Option<String> {
        self.entries.insert(asset, location.into())
    }

    /// Where an asset's bytes resolve, if the map names it.
    pub fn get(&self, asset: &AssetId) -> Option<&str> {
        self.entries.get(asset).map(String::as_str)
    }

    /// The entries, in canonical asset-id order.
    pub fn iter(&self) -> impl Iterator<Item = (&AssetId, &str)> {
        self.entries.iter().map(|(id, path)| (id, path.as_str()))
    }

    /// How many assets the map names.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the map names no assets at all.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Read a `{ <asset id>: <resolved path or URL> }` object.
    pub fn from_value(value: &Value) -> Result<MediaMap, Error> {
        let object = value.as_object().ok_or_else(|| {
            Error::Media("a media map is an { asset id: path } object (KMI §4.3)".into())
        })?;
        let mut map = MediaMap::new();
        for (curie, location) in object {
            let location = location.as_str().ok_or_else(|| {
                Error::Media(format!(
                    "media-map entry {curie:?} must resolve to a path or URL string (KMI §4.3)"
                ))
            })?;
            map.insert(AssetId::parse(curie)?, location);
        }
        Ok(map)
    }

    /// The map as the JSON object §4.3 describes.
    pub fn to_value(&self) -> Value {
        Value::Object(
            self.entries
                .iter()
                .map(|(id, path)| (id.as_str().to_string(), Value::String(path.clone())))
                .collect(),
        )
    }

    /// The map inverted for relinking: normalized location → asset id.
    ///
    /// Two assets resolving to one location is refused rather than resolved by guess — the
    /// map's whole job is to say which bytes a path holds, and an ambiguous map cannot.
    fn by_location(&self) -> Result<BTreeMap<String, &AssetId>, Error> {
        let mut index: BTreeMap<String, &AssetId> = BTreeMap::new();
        for (asset, location) in &self.entries {
            let key = normalize_location(location);
            if let Some(existing) = index.insert(key, asset) {
                return Err(Error::Media(format!(
                    "media map resolves both {existing} and {asset} to {location:?}; \
                     relinking cannot tell which bytes are there (KMI §4.3)"
                )));
            }
        }
        Ok(index)
    }
}

impl FromIterator<(AssetId, String)> for MediaMap {
    fn from_iter<I: IntoIterator<Item = (AssetId, String)>>(iter: I) -> MediaMap {
        MediaMap {
            entries: iter.into_iter().collect(),
        }
    }
}

/// Reduce a `target_url` and a media-map location to the same comparable form.
///
/// OTIO writes `file:///conform/shot.mov`; a media map names `/conform/shot.mov`. Only the
/// `file:` scheme is unwrapped — a remote URL is compared verbatim, since its authority is
/// part of where the bytes are.
fn normalize_location(location: &str) -> String {
    location
        .strip_prefix("file://")
        .unwrap_or(location)
        .to_string()
}

// --- reading and repairing identity on a timeline -------------------------------------

impl Timeline {
    /// The media map §4.2d lets a producer carry on the timeline itself, if it carries one.
    pub fn media_map(&self) -> Result<Option<MediaMap>, Error> {
        self.koine_metadata()
            .and_then(|koine| koine.get("media_map"))
            .map(MediaMap::from_value)
            .transpose()
    }

    /// Every clip media reference, with the asset id §4.2a requires of it.
    pub fn asset_references(&self) -> Result<Vec<AssetReference<'_>>, Error> {
        let mut out = Vec::new();
        for clip in self.clips() {
            for reference in &clip.media_references {
                out.push(AssetReference {
                    clip: clip.name,
                    key: reference.key,
                    schema: reference.schema,
                    target_url: reference.target_url,
                    asset: reference.asset()?,
                });
            }
        }
        Ok(out)
    }

    /// The distinct assets this timeline plays, in canonical id order.
    pub fn asset_ids(&self) -> Result<BTreeSet<AssetId>, Error> {
        Ok(self
            .asset_references()?
            .into_iter()
            .filter_map(|reference| reference.asset)
            .collect())
    }

    /// The references whose identity is missing — what §9.5 calls the exposure, made
    /// detectable. A non-empty result after a trip through a third-party tool is the
    /// signal to [`relink`](Timeline::relink).
    pub fn unidentified_references(&self) -> Result<Vec<AssetReference<'_>>, Error> {
        Ok(self
            .asset_references()?
            .into_iter()
            .filter(|reference| reference.asset.is_none())
            .collect())
    }

    /// Re-attach the asset ids a path-addressing round trip dropped, using the §4.3 media
    /// map, and return the repaired timeline.
    ///
    /// This is the whole of koine's answer to §9.5. It is deliberately *not* a heuristic:
    ///
    /// - a reference that **already** carries an id keeps it, even where the map disagrees
    ///   — the id is authoritative and the `target_url` advisory (§4.2a), so the map never
    ///   overrides identity, it only supplies what is absent;
    /// - a reference whose location the map does not name is left unidentified rather than
    ///   guessed at, and [`unidentified_references`](Timeline::unidentified_references)
    ///   still reports it — nothing is invented;
    /// - the supplied map rides home on the repaired timeline (`metadata.koine.media_map`,
    ///   §4.2d), so the next hop is self-describing rather than dependent on the map
    ///   having travelled beside the document a second time.
    ///
    /// The composition is untouched: only `metadata.koine` dicts are written, so the
    /// document remains the OTIO one the adapter produced.
    pub fn relink(&self, media_map: &MediaMap) -> Result<Timeline, Error> {
        let by_location = media_map.by_location()?;
        let mut doc = self.as_value().clone();
        if let Some(tracks) = doc.get_mut("tracks") {
            relink_item(tracks, &by_location);
        }
        if !media_map.is_empty() {
            let root = doc
                .as_object_mut()
                .ok_or_else(|| Error::Media("a canonical timeline is an object".into()))?;
            if let Some(koine) = koine_metadata_mut(root) {
                koine.insert("media_map".to_string(), media_map.to_value());
            }
        }
        Timeline::from_value(doc)
    }
}

/// Walk a composition item, relinking every clip beneath it.
fn relink_item(item: &mut Value, by_location: &BTreeMap<String, &AssetId>) {
    match otio_class(item) {
        Some("Clip") => relink_clip(item, by_location),
        Some("Track" | "Stack") => {
            if let Some(children) = item.get_mut("children").and_then(Value::as_array_mut) {
                for child in children {
                    relink_item(child, by_location);
                }
            }
        }
        _ => {}
    }
}

/// Relink a clip's media references — the `Clip.1` singular and the `Clip.2` map alike,
/// since either may arrive (§4.1).
fn relink_clip(clip: &mut Value, by_location: &BTreeMap<String, &AssetId>) {
    if let Some(reference) = clip.get_mut("media_reference") {
        relink_reference(reference, by_location);
    }
    if let Some(references) = clip
        .get_mut("media_references")
        .and_then(Value::as_object_mut)
    {
        for reference in references.values_mut() {
            relink_reference(reference, by_location);
        }
    }
}

/// Attach the asset id the map names for this reference's location, if it has none.
fn relink_reference(reference: &mut Value, by_location: &BTreeMap<String, &AssetId>) {
    let Some(object) = reference.as_object_mut() else {
        return;
    };
    let identified = object
        .get("metadata")
        .and_then(|metadata| metadata.get(KOINE_METADATA_KEY))
        .and_then(|koine| koine.get(ASSET_KIND))
        .is_some();
    if identified {
        return;
    }
    let Some(location) = object
        .get("target_url")
        .and_then(Value::as_str)
        .map(normalize_location)
    else {
        return;
    };
    let Some(asset) = by_location.get(&location) else {
        return;
    };
    let curie = Value::String(asset.as_str().to_string());
    if let Some(koine) = koine_metadata_mut(object) {
        koine.insert(ASSET_KIND.to_string(), curie);
    }
}

/// The `metadata.koine` dict of an OTIO node, created if absent.
///
/// `None` when `metadata` or `metadata.koine` is present but is not an object — someone
/// else's data, which this layer overwrites under no circumstances.
fn koine_metadata_mut(node: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    let metadata = node
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    if metadata.is_null() {
        *metadata = Value::Object(Map::new());
    }
    let koine = metadata
        .as_object_mut()?
        .entry(KOINE_METADATA_KEY)
        .or_insert_with(|| Value::Object(Map::new()));
    if koine.is_null() {
        *koine = Value::Object(Map::new());
    }
    koine.as_object_mut()
}

// --- (b) the asset-lineage graph (§3) -------------------------------------------------

/// One of KMI §3's four asset-lineage relations.
///
/// They live in the relation registry under the [`media`](LINEAGE_DOMAIN) domain and are
/// ordinary KGP assertions, which is what gives a lineage edge confidence and provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LineageRelation {
    /// B is a transcode / re-encode / render of A.
    DerivedFrom,
    /// B is a rendition of A at a different resolution / format / bitrate.
    VariantOf,
    /// B is a time/space sub-range of A. The range itself rides B's asset envelope, not
    /// the relation — every lineage relation is binary, like every KGP assertion.
    ExcerptOf,
    /// A and B are perceptually the same content. **Probabilistic, and never identity.**
    PerceptualMatch,
}

impl LineageRelation {
    /// The four, in the order KMI §3's table lists them.
    pub const ALL: [LineageRelation; 4] = [
        LineageRelation::DerivedFrom,
        LineageRelation::VariantOf,
        LineageRelation::ExcerptOf,
        LineageRelation::PerceptualMatch,
    ];

    /// The registry CURIE — `media:excerpt_of`.
    pub fn curie(self) -> &'static str {
        match self {
            LineageRelation::DerivedFrom => "media:derived_from",
            LineageRelation::VariantOf => "media:variant_of",
            LineageRelation::ExcerptOf => "media:excerpt_of",
            LineageRelation::PerceptualMatch => "media:perceptual_match",
        }
    }

    /// Read a relation from its registry CURIE.
    pub fn parse(curie: &str) -> Result<LineageRelation, Error> {
        LineageRelation::ALL
            .into_iter()
            .find(|relation| relation.curie() == curie)
            .ok_or_else(|| {
                Error::Media(format!(
                    "{curie:?} is not an asset-lineage relation (KMI §3 registers four \
                     under the {LINEAGE_DOMAIN} domain)"
                ))
            })
    }

    /// **Always false**, for every relation, and load-bearing (KMI §3 / KINP delta E).
    ///
    /// Byte hash is identity; lineage is how *different* assets relate. In particular a
    /// `perceptual_match` is a similarity signal that feeds a review queue exactly like a
    /// KINP `same_as` proposal — proposed, never auto-merged. Nothing in this crate may
    /// collapse two asset ids because a lineage edge joins them.
    pub fn is_identity_bearing(self) -> bool {
        false
    }

    /// Whether the relation leads from a composite to a **constituent** whose world scopes
    /// claims about it (KMI §5: traced via `media:excerpt_of` / `media:derived_from`).
    pub fn traces_to_constituent(self) -> bool {
        matches!(
            self,
            LineageRelation::ExcerptOf | LineageRelation::DerivedFrom
        )
    }
}

impl fmt::Display for LineageRelation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.curie())
    }
}

/// A binary lineage edge between two assets, with its confidence and provenance.
#[derive(Debug, Clone, PartialEq)]
pub struct LineageLink {
    /// Which of §3's four relations this is.
    pub relation: LineageRelation,
    /// The derived asset — the subject.
    pub subject: AssetId,
    /// The asset it derives from — the object.
    pub object: AssetId,
    /// KGP confidence. `1.0` for a recorded transform; below it for a proposal such as a
    /// perceptual match.
    pub confidence: f64,
    /// The run or agent that asserted the link.
    pub source: Option<String>,
}

impl LineageLink {
    /// A certain (`confidence: 1.0`) lineage link — a transform the producer performed and
    /// therefore knows.
    pub fn certain(relation: LineageRelation, subject: AssetId, object: AssetId) -> LineageLink {
        LineageLink {
            relation,
            subject,
            object,
            confidence: 1.0,
            source: None,
        }
    }

    /// The link as the KGP assertion it is (§3). Lineage states how bytes relate, not what
    /// is true in a world, so it carries no world scope.
    pub fn to_assertion(&self) -> Assertion {
        Assertion {
            world: None,
            relation: self.relation.curie().to_string(),
            subject: self.subject.as_str().to_string(),
            object: self.object.as_str().to_string(),
            confidence: self.confidence,
            source: self.source.clone(),
        }
    }
}

/// The asset-lineage graph — an asset graph parallel to, and distinct from, the KGP
/// knowledge graph (§3).
///
/// It is held **outside** any timeline (§4.2b). A timeline is one node in it, so no
/// adapter round trip can touch it; what a round trip can break is the *join* between the
/// two, which is the timeline's asset ids — see [`Timeline::relink`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LineageGraph {
    links: Vec<LineageLink>,
}

impl LineageGraph {
    /// An empty graph.
    pub fn new() -> LineageGraph {
        LineageGraph::default()
    }

    /// Record a lineage link.
    pub fn insert(&mut self, link: LineageLink) {
        self.links.push(link);
    }

    /// Every link, in insertion order.
    pub fn links(&self) -> &[LineageLink] {
        &self.links
    }

    /// The links incident to any of `assets`.
    pub fn touching<'a>(&'a self, assets: &BTreeSet<AssetId>) -> Vec<&'a LineageLink> {
        self.links
            .iter()
            .filter(|link| assets.contains(&link.subject) || assets.contains(&link.object))
            .collect()
    }

    /// The lineage of the assets a timeline plays — the sub-graph a consumer of this
    /// timeline needs.
    ///
    /// It is reached *through the asset ids in the document*, which is why relinking after
    /// a path-addressing round trip is what keeps lineage attached to an edit: the links
    /// never went anywhere, but a timeline that has forgotten its asset ids can no longer
    /// name them.
    pub fn for_timeline(&self, timeline: &Timeline) -> Result<Vec<&LineageLink>, Error> {
        Ok(self.touching(&timeline.asset_ids()?))
    }

    /// The assets `asset` was composed from, transitively (§5's `media:excerpt_of` /
    /// `media:derived_from` trace), in canonical id order.
    ///
    /// `perceptual_match` is never followed: it is a similarity signal, so treating it as
    /// a composition edge would attribute a claim to a world on the strength of two files
    /// looking alike.
    pub fn constituents(&self, asset: &AssetId) -> Vec<&AssetId> {
        let mut seen: BTreeSet<&AssetId> = BTreeSet::new();
        let mut frontier = vec![asset];
        while let Some(current) = frontier.pop() {
            for link in &self.links {
                if !link.relation.traces_to_constituent() || &link.subject != current {
                    continue;
                }
                if seen.insert(&link.object) {
                    frontier.push(&link.object);
                }
            }
        }
        seen.remove(asset);
        seen.into_iter().collect()
    }

    /// Every link as a KGP assertion (§3).
    pub fn assertions(&self) -> Vec<Assertion> {
        self.links.iter().map(LineageLink::to_assertion).collect()
    }
}

impl FromIterator<LineageLink> for LineageGraph {
    fn from_iter<I: IntoIterator<Item = LineageLink>>(iter: I) -> LineageGraph {
        LineageGraph {
            links: iter.into_iter().collect(),
        }
    }
}

// --- (c) the analysis → knowledge bridge (§5) -----------------------------------------

/// The KMI §2 asset envelope, in the two parts the bridge needs: what world the bytes
/// depict, and which entities they depict.
///
/// Both are per-asset (delta H) and neither is identity-bearing — the id is the hash, and
/// everything here is metadata *about* those bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetEnvelope {
    /// The content-addressed id (KINP §7.2).
    pub id: AssetId,
    /// The asset's media type.
    pub media_type: String,
    /// The world these bytes **depict**, scoping any knowledge extracted from them (§5).
    /// `None` for a generated/synthesized asset, which depicts no world.
    pub source_world: Option<String>,
    /// The KINP entities the asset depicts (§2).
    pub attaches_to: Vec<String>,
}

impl AssetEnvelope {
    /// An **ingested**, world-depicting asset: `source_world` is required of it (delta H),
    /// and it is what engages the KINP §4.3 firewall.
    pub fn ingested(
        id: AssetId,
        media_type: impl Into<String>,
        source_world: impl Into<String>,
        attaches_to: Vec<String>,
    ) -> AssetEnvelope {
        AssetEnvelope {
            id,
            media_type: media_type.into(),
            source_world: Some(source_world.into()),
            attaches_to,
        }
    }

    /// A **generated/synthesized** asset — a TTS narration, a composed score, a render.
    /// It depicts no world, so `source_world` is null (§2, delta H) and claims about it
    /// are attributed through its constituents (§5).
    pub fn generated(id: AssetId, media_type: impl Into<String>) -> AssetEnvelope {
        AssetEnvelope {
            id,
            media_type: media_type.into(),
            source_world: None,
            attaches_to: Vec::new(),
        }
    }
}

/// One finding of a media analysis — vision, ASR, av-analysis — before it is scoped to a
/// world.
///
/// This is the bridge's **media-plane input** ([`ANALYSIS_BRIDGE_INPUT_PLANE`]): a
/// producer's observation about an asset's bytes. It is not yet a claim, because nothing
/// here says which world it is true in; supplying that is [`analysis_assertions`]' whole
/// job, and is what keeps the firewall correct.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisObservation {
    /// The asset that was analyzed.
    pub asset: AssetId,
    /// The registry relation the finding uses — `cine:shows`, `cine:depicts`, … (§5).
    pub relation: String,
    /// The KINP entity the finding is about.
    pub entity: String,
    /// How sure the analysis is, in `[0, 1]`.
    pub confidence: f64,
    /// The analysis run — `analyzer:run/1a2b`.
    pub source: String,
}

/// A KGP assertion: a binary relation in a world, with confidence and provenance.
///
/// This is the bridge's **knowledge-plane output** ([`plane`](Assertion::plane)) and the
/// normative form of everything koine adds outside the timeline — both the lineage links
/// of §3 and the analysis claims of §5. It is a *record*, not prose: an OTIO `Marker`
/// carrying a sentence, or a model's paragraph about a clip, is neither addressable,
/// dedupable, nor scopable to a world, and so is not knowledge on this plane at all. A
/// producer MAY mirror an assertion as a `Marker` for editorial display; this stays the
/// normative form (§4.2c).
#[derive(Debug, Clone, PartialEq)]
pub struct Assertion {
    /// The world the claim holds in (KINP §5). `Some` for everything the analysis bridge
    /// emits — that is the firewall (KINP §4.3). `None` for a lineage link, which relates
    /// bytes rather than asserting anything about a world.
    pub world: Option<String>,
    /// The registry relation CURIE.
    pub relation: String,
    /// The subject CURIE.
    pub subject: String,
    /// The object CURIE.
    pub object: String,
    /// KGP confidence, in `[0, 1]`.
    pub confidence: f64,
    /// The run or agent that asserted it.
    pub source: Option<String>,
}

impl Assertion {
    /// The KCB plane this record belongs to (§6 / KCB §2.1) — always `knowledge`, however
    /// media-plane its origin. An assertion *is* the knowledge plane's payload; the media
    /// plane moves bytes.
    pub fn plane(&self) -> &'static str {
        ANALYSIS_BRIDGE_OUTPUT_PLANE
    }
}

/// Bridge media analysis into knowledge: KGP assertions, scoped to the right world.
///
/// This is KMI §5, and it is unchanged by the OTIO adoption — it never touched the
/// timeline model, it takes assets and findings about their bytes. What it adds to a bare
/// observation is the part a producer must not guess:
///
/// - **the world**, from the analyzed asset's own `source_world` when it has one;
/// - **or its constituents' worlds**, when it does not. Analysis of a composite — a
///   render, a preview — attributes each claim to the constituent clip's world, traced
///   through [`LineageGraph::constituents`], because a generated render has
///   `source_world: null` and scoping the whole render to one world would wrongly drop its
///   clips' claims out of every fictional world (delta H).
///
/// An observation the bridge cannot scope is an error, never a claim in consensus reality:
/// the firewall is not a default, it is a refusal. Likewise a finding about an entity the
/// attributing asset does not `attaches_to` is refused rather than asserted (§5 scopes
/// claims to the entities the asset depicts).
///
/// A composite that depicts entities through several constituents yields one assertion per
/// attributing world, in canonical asset-id order.
pub fn analysis_assertions(
    observations: &[AnalysisObservation],
    envelopes: &[AssetEnvelope],
    lineage: &LineageGraph,
) -> Result<Vec<Assertion>, Error> {
    let mut by_id: BTreeMap<&AssetId, &AssetEnvelope> = BTreeMap::new();
    for envelope in envelopes {
        if by_id.insert(&envelope.id, envelope).is_some() {
            return Err(Error::Media(format!(
                "two asset envelopes for {} — an asset id is the hash of its bytes and \
                 names exactly one envelope (KINP §7.2)",
                envelope.id
            )));
        }
    }

    let mut out = Vec::new();
    for observation in observations {
        check_registry_relation(&observation.relation)?;
        check_confidence(observation.confidence, &observation.relation)?;
        let envelope = by_id.get(&observation.asset).copied().ok_or_else(|| {
            Error::Media(format!(
                "no asset envelope for {} — a claim's world scope comes from the analyzed \
                 asset's envelope, so analysis of an unknown asset cannot be scoped (KMI §5)",
                observation.asset
            ))
        })?;

        let attributing = attributing_assets(envelope, &by_id, lineage);
        if attributing.is_empty() {
            return Err(Error::Media(format!(
                "{} has no source_world and no ingested constituent to attribute to, so \
                 analysis of it scopes to no world; the bridge will not place a claim in \
                 consensus reality by default (KMI §5 / delta H)",
                observation.asset
            )));
        }
        let mut emitted = 0;
        for source in &attributing {
            if !source
                .attaches_to
                .iter()
                .any(|entity| entity == &observation.entity)
            {
                continue;
            }
            let world = source
                .source_world
                .clone()
                .expect("an attributing asset has a source_world");
            out.push(Assertion {
                world: Some(world),
                relation: observation.relation.clone(),
                subject: observation.asset.as_str().to_string(),
                object: observation.entity.clone(),
                confidence: observation.confidence,
                source: Some(observation.source.clone()),
            });
            emitted += 1;
        }
        if emitted == 0 {
            return Err(Error::Media(format!(
                "analysis of {} claims {} of {:?}, which no attributing asset attaches_to \
                 — a claim is scoped to the entities the asset depicts (KMI §2/§5)",
                observation.asset, observation.relation, observation.entity
            )));
        }
    }
    Ok(out)
}

/// The assets whose `source_world` scopes a claim about `envelope`: itself when it depicts
/// a world, else the constituents that do (§5, delta H).
fn attributing_assets<'a>(
    envelope: &'a AssetEnvelope,
    by_id: &BTreeMap<&AssetId, &'a AssetEnvelope>,
    lineage: &LineageGraph,
) -> Vec<&'a AssetEnvelope> {
    if envelope.source_world.is_some() {
        return vec![envelope];
    }
    lineage
        .constituents(&envelope.id)
        .into_iter()
        .filter_map(|id| by_id.get(id).copied())
        .filter(|constituent| constituent.source_world.is_some())
        .collect()
}

/// A registry relation CURIE: `<domain>:<snake_case>` (KGP §3.2 rule 1).
///
/// Only the *shape* is checked. The relation registry is koine's data, not agora's — an
/// agora that decided which relations exist would be a second authored copy of it.
fn check_registry_relation(relation: &str) -> Result<(), Error> {
    match relation.split_once(':') {
        Some((domain, name)) if is_lower_ident(domain) && is_snake_case(name) => Ok(()),
        _ => Err(Error::Media(format!(
            "{relation:?} is not a relation-registry CURIE — a KGP relation is a \
             snake_case name in a domain, like `cine:shows` (KGP §3.2)"
        ))),
    }
}

fn check_confidence(confidence: f64, relation: &str) -> Result<(), Error> {
    if (0.0..=1.0).contains(&confidence) {
        return Ok(());
    }
    Err(Error::Media(format!(
        "confidence {confidence} for {relation:?} is not in [0, 1] (KGP §7)"
    )))
}

/// Project KGP assertions into the engine's own fact vocabulary, ready for the ProbLog /
/// Prolog / Soufflé emitters.
///
/// This is the same mechanical projection the canonical graph gets — a claim's confidence
/// becomes the annotated fact's probability, and the world and provenance ride queryable
/// companions:
///
/// ```text
/// 0.88::rel('cine:shows', 'analyzer:asset:blake3-c3d4…', 'worldsim:world:alderforest:ent:npc-renaud').
/// rel_conf('cine:shows', …, 0.88).
/// rel_world('cine:shows', …, 'worldsim:world:alderforest').
/// rel_source('cine:shows', …, 'analyzer:run/1a2b').
/// ```
///
/// Only the generic `rel/3` view is emitted, not the typed `<type>/2` companion the
/// canonical-graph projection also writes: a registry relation is domain-qualified, and
/// flattening `cine:shows` to `shows/2` would collide with any other domain's `shows`.
/// `rel_world/4` is this projection's own companion — the canonical graph has no world
/// column, and a claim that lost its world would be a firewall breach, not a rounding.
pub fn assertion_facts(assertions: &[Assertion]) -> Result<Vec<AnnotatedFact>, Error> {
    let mut out = Vec::new();
    for assertion in assertions {
        check_registry_relation(&assertion.relation)?;
        check_confidence(assertion.confidence, &assertion.relation)?;
        let triple = vec![
            Atom::Sym(assertion.relation.clone()),
            Atom::Sym(assertion.subject.clone()),
            Atom::Sym(assertion.object.clone()),
        ];
        out.push(AnnotatedFact {
            fact: Fact::new("rel", triple.clone(), assertion.source.clone()),
            probability: Some(assertion.confidence),
        });
        let mut companion = |predicate: &str, tail: Atom| {
            let mut args = triple.clone();
            args.push(tail);
            out.push(AnnotatedFact::certain(Fact::new(
                predicate,
                args,
                assertion.source.clone(),
            )));
        };
        companion("rel_conf", Atom::Float(assertion.confidence));
        if let Some(world) = &assertion.world {
            companion("rel_world", Atom::Sym(world.clone()));
        }
        if let Some(source) = &assertion.source {
            companion("rel_source", Atom::Sym(source.clone()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(curie: &str) -> AssetId {
        AssetId::parse(curie).expect("a well-formed asset id")
    }

    /// The id is the hash of the bytes (KINP §2/§6), so an id that is a *name* is not an
    /// asset id at all — accepting one would let a producer mint identity by assertion.
    #[test]
    fn an_asset_id_must_be_content_addressed() {
        let id = asset("analyzer:asset:blake3-c3d4e5f6a1b2");
        assert_eq!(id.namespace(), "analyzer");
        assert_eq!(id.hash_algorithm(), "blake3");
        assert_eq!(id.digest(), "c3d4e5f6a1b2");

        for name in [
            "mediastore:asset:renaud-approach",
            "mediastore:asset:master",
            "mediastore:asset:blake3-",
        ] {
            let err = AssetId::parse(name).unwrap_err().to_string();
            assert!(err.contains("content-addressed"), "{name}: {err}");
        }
    }

    /// A clip references *bytes*. An entity id where §4.2a requires an asset is a category
    /// error, not a near miss.
    #[test]
    fn an_entity_id_is_not_an_asset_id() {
        let err = AssetId::parse("worldsim:ent:npc-renaud")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a \"ent\""), "{err}");
    }

    /// §3: no lineage relation is identity-bearing — a re-encode is its own asset, and a
    /// perceptual match is a proposal.
    #[test]
    fn no_lineage_relation_is_identity_bearing() {
        assert!(LineageRelation::ALL
            .iter()
            .all(|relation| !relation.is_identity_bearing()));
        assert!(!LineageRelation::PerceptualMatch.traces_to_constituent());
        assert_eq!(
            LineageRelation::parse("media:excerpt_of").unwrap(),
            LineageRelation::ExcerptOf
        );
    }

    /// The map's job is to say which bytes are at a path; one that answers twice cannot.
    #[test]
    fn an_ambiguous_media_map_is_refused_rather_than_guessed() {
        let mut map = MediaMap::new();
        map.insert(asset("analyzer:asset:blake3-aaaaaaaa"), "/conform/a.mov");
        map.insert(
            asset("analyzer:asset:blake3-bbbbbbbb"),
            "file:///conform/a.mov",
        );
        let err = map.by_location().unwrap_err().to_string();
        assert!(err.contains("cannot tell which bytes"), "{err}");
    }
}
