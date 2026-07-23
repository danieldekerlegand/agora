% culture-scrape — ProbLog probabilistic fact base
% ================================================
% Auto-generated from the canonical TSV graph (docs/data-model.md); a derived,
% mechanical projection — do not edit by hand.
%
% ProbLog dialect (https://dtai.cs.kuleuven.be/problog/): Prolog syntax with
% annotated facts. An edge's confidence becomes the fact's probability:
%   0.8::located_in('cs:dish:Q42', 'cs:place:Q123').
% A confidence of 1.0 (or none) is a certain fact, written unannotated. Node,
% dimension and provenance facts are certain. The shared Horn inference rules
% (--rules) are ProbLog-compatible verbatim.
%
% Predicate schema (see graph.pl's header for the full vocabulary):
%   node(Csid, Type, Name)        entity: csid, primary label, display name
%   instance_of(Csid, Label)      one per label
%   <dimension>(Csid, Value)      time_start/2, language_code/2, derived_from/2, ...
%   W::rel(Type, A, B)            generic edge, W = confidence (omitted when 1.0)
%   W::<type>(A, B)               typed edge, one binary predicate per :TYPE
%   rel_conf(Type, A, B, W)       queryable confidence companion (certain)
%   rel_source(Type, A, B, Src)   queryable provenance companion (certain)
%
% Query: add e.g. `query(within_region('cs:dish:Q42', X)).`, then run
%        `problog this_file.problog.pl` (pip install problog).

node('cs:dish:Q42', 'Cuisine', 'Ceviche\twith\ttabs').
instance_of('cs:dish:Q42', 'Cuisine').
instance_of('cs:dish:Q42', 'Ingredient').
time_start('cs:dish:Q42', -1200).
node('cs:language:Q150', 'Language', 'French').  % source: wikidata
instance_of('cs:language:Q150', 'Language').  % source: wikidata
source('cs:language:Q150', wikidata).  % source: wikidata
located_at('cs:language:Q150', 48.8566, 2.3522).  % source: wikidata
time_start('cs:language:Q150', 842).  % source: wikidata
language_code('cs:language:Q150', fr).  % source: wikidata
node('cs:place:Q90', 'Place', 'Paris').  % source: wikidata
instance_of('cs:place:Q90', 'Place').  % source: wikidata
source('cs:place:Q90', wikidata).  % source: wikidata
located_at('cs:place:Q90', 48.8566, 2.3522).  % source: wikidata
place_qid('cs:place:Q90', 'Q90').  % source: wikidata
0.5::rel(derived_from, 'cs:dish:Q42', 'cs:place:Q90').  % source: editorial
0.5::derived_from('cs:dish:Q42', 'cs:place:Q90').  % source: editorial
rel_conf(derived_from, 'cs:dish:Q42', 'cs:place:Q90', 0.5).  % source: editorial
rel_source(derived_from, 'cs:dish:Q42', 'cs:place:Q90', editorial).  % source: editorial
0.7::rel(located_in, 'cs:language:Q150', 'cs:place:Q90').  % source: wikidata
0.7::located_in('cs:language:Q150', 'cs:place:Q90').  % source: wikidata
rel_conf(located_in, 'cs:language:Q150', 'cs:place:Q90', 0.7).  % source: wikidata
rel_source(located_in, 'cs:language:Q150', 'cs:place:Q90', wikidata).  % source: wikidata
0.9::rel(spoken_in, 'cs:language:Q150', 'cs:place:Q90').  % source: wikidata
0.9::spoken_in('cs:language:Q150', 'cs:place:Q90').  % source: wikidata
rel_conf(spoken_in, 'cs:language:Q150', 'cs:place:Q90', 0.9).  % source: wikidata
rel_source(spoken_in, 'cs:language:Q150', 'cs:place:Q90', wikidata).  % source: wikidata
