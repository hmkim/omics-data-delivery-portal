-- Q3 evidence (customer question, 2026-10-02): does an interrupted download count the bytes served or the object size?
-- CloudFront standard logs v2 (parquet, all columns string): sc_bytes = bytes CloudFront served to the viewer (incl. headers),
-- sc_content_len = Content-Length of the response the viewer asked for, sc_range_start/end = requested Range.
-- Rows whose result type is Error with ClientCommError/ClientHungUp are viewer-side aborts.
SELECT
  dt,
  "time",
  x_edge_result_type                         AS result,
  x_edge_detailed_result_type                AS detail,
  sc_status                                  AS status,
  try_cast(sc_bytes AS bigint)               AS bytes_served,
  try_cast(sc_content_len AS bigint)         AS content_len,
  try_cast(sc_range_start AS bigint)         AS range_start,
  try_cast(sc_range_end AS bigint)           AS range_end,
  round(try_cast(sc_bytes AS double) / nullif(try_cast(sc_content_len AS double), 0) * 100, 2) AS served_pct,
  c_country,
  regexp_extract(cs_uri_stem, '[^/]+$')      AS object
FROM "genome-portal-logs"."genome-portal-cf-access-logs"
WHERE dt BETWEEN '2026/09/28' AND '2026/10/02'
  AND try_cast(sc_content_len AS bigint) > 1000000
  AND (x_edge_result_type = 'Error' OR try_cast(sc_bytes AS bigint) < try_cast(sc_content_len AS bigint) * 0.95)
ORDER BY dt, "time";
