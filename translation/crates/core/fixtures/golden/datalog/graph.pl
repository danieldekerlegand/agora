% culture-scrape — SWI-Prolog fact base
% =====================================
% Auto-generated from the canonical TSV graph (docs/data-model.md); a derived,
% mechanical projection — do not edit by hand.
%
% Predicate schema
% ----------------
%   node(Csid, Type, Name)        entity: csid, primary :LABEL, display name
%   instance_of(Csid, Label)      one per :LABEL (a multi-label node repeats)
%   located_at(Csid, Lat, Lon)    geographic coordinate (floats)
%   <dimension>(Csid, Value)      binary dimension facts, e.g. time_start/2,
%                                 time_end/2, part_of_period/2, language_code/2,
%                                 derived_from/2, ...
%   rel(Type, A, B)               generic edge: type atom + endpoint csids
%   <type>(A, B)                  typed edge, one binary predicate per :TYPE
%                                 (e.g. located_in/2, adjacent_to/2)
%   rel_conf(Type, A, B, Weight)  optional edge weight/confidence (float)
%
% Csids are carried verbatim as single-quoted atoms ('cs:dish:Q42'); the same
% csid always renders to the same atom, so the mapping is reversible.
%
% Load:  swipl this_file.pl
% Query: ?- node(X, 'Dish', Name).


:- discontiguous derived_from/2.
:- discontiguous instance_of/2.
:- discontiguous language_code/2.
:- discontiguous located_at/3.
:- discontiguous located_in/2.
:- discontiguous node/3.
:- discontiguous place_qid/2.
:- discontiguous rel/3.
:- discontiguous rel_conf/4.
:- discontiguous rel_source/4.
:- discontiguous source/2.
:- discontiguous spoken_in/2.
:- discontiguous time_start/2.

:- dynamic derived_from/2.
:- dynamic instance_of/2.
:- dynamic language_code/2.
:- dynamic located_at/3.
:- dynamic located_in/2.
:- dynamic node/3.
:- dynamic place_qid/2.
:- dynamic rel/3.
:- dynamic rel_conf/4.
:- dynamic rel_source/4.
:- dynamic source/2.
:- dynamic spoken_in/2.
:- dynamic time_start/2.

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
rel(derived_from, 'cs:dish:Q42', 'cs:place:Q90').  % source: editorial
derived_from('cs:dish:Q42', 'cs:place:Q90').  % source: editorial
rel_conf(derived_from, 'cs:dish:Q42', 'cs:place:Q90', 0.5).  % source: editorial
rel_source(derived_from, 'cs:dish:Q42', 'cs:place:Q90', editorial).  % source: editorial
rel(located_in, 'cs:language:Q150', 'cs:place:Q90').  % source: wikidata
located_in('cs:language:Q150', 'cs:place:Q90').  % source: wikidata
rel_conf(located_in, 'cs:language:Q150', 'cs:place:Q90', 0.7).  % source: wikidata
rel_source(located_in, 'cs:language:Q150', 'cs:place:Q90', wikidata).  % source: wikidata
rel(spoken_in, 'cs:language:Q150', 'cs:place:Q90').  % source: wikidata
spoken_in('cs:language:Q150', 'cs:place:Q90').  % source: wikidata
rel_conf(spoken_in, 'cs:language:Q150', 'cs:place:Q90', 0.9).  % source: wikidata
rel_source(spoken_in, 'cs:language:Q150', 'cs:place:Q90', wikidata).  % source: wikidata
