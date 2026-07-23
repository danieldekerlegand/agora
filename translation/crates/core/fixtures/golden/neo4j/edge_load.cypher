LOAD CSV WITH HEADERS FROM $file AS row FIELDTERMINATOR '\t'
MATCH (start {csid: row.`:START_ID`})
MATCH (end {csid: row.`:END_ID`})
CALL apoc.merge.relationship(
  start, row.`:TYPE`, {}, {
  `weight`: toFloat(row.`weight:float`),
  `time_start`: toInteger(row.`time_start:int`),
  `time_end`: toInteger(row.`time_end:int`),
  `pinakes_id`: row.`pinakes_id`,
  `source`: row.`source`,
  `source_url`: row.`source_url`,
  `source_query`: row.`source_query`,
  `retrieved_at`: row.`retrieved_at`,
  `confidence`: toFloat(row.`confidence:float`),
  `license`: row.`license`
}, end, {
  `weight`: toFloat(row.`weight:float`),
  `time_start`: toInteger(row.`time_start:int`),
  `time_end`: toInteger(row.`time_end:int`),
  `pinakes_id`: row.`pinakes_id`,
  `source`: row.`source`,
  `source_url`: row.`source_url`,
  `source_query`: row.`source_query`,
  `retrieved_at`: row.`retrieved_at`,
  `confidence`: toFloat(row.`confidence:float`),
  `license`: row.`license`
}
) YIELD rel
RETURN count(rel);