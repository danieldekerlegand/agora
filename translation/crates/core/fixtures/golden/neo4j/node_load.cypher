LOAD CSV WITH HEADERS FROM $file AS row FIELDTERMINATOR '\t'
MERGE (n:Entity {`csid`: row.`csid:ID`})
SET n += {
  `name`: row.`name`,
  `lang`: row.`lang`,
  `wikidata_qid`: row.`wikidata_qid`,
  `getty_id`: row.`getty_id`,
  `aliases`: split(row.`aliases`, ';'),
  `description`: row.`description`,
  `pinakes_id`: row.`pinakes_id`,
  `time_start`: toInteger(row.`time_start:int`),
  `time_end`: toInteger(row.`time_end:int`),
  `time_start_iso`: row.`time_start_iso`,
  `period`: row.`period`,
  `lat`: toFloat(row.`lat:float`),
  `lon`: toFloat(row.`lon:float`),
  `place_qid`: row.`place_qid`,
  `tgn_id`: row.`tgn_id`,
  `pleiades_id`: row.`pleiades_id`,
  `language_code`: row.`language_code`,
  `script`: row.`script`,
  `etymology`: row.`etymology`,
  `derived_from_csid`: row.`derived_from_csid`,
  `source`: row.`source`,
  `source_url`: row.`source_url`,
  `source_query`: row.`source_query`,
  `retrieved_at`: row.`retrieved_at`,
  `confidence`: toFloat(row.`confidence:float`),
  `license`: row.`license`
}
WITH n, row
CALL apoc.create.addLabels(n, split(row.`:LABEL`, ';')) YIELD node
RETURN count(node);