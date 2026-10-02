SELECT CASE WHEN concat(date, ' ', time) < '2026-09-29 05:29:00' THEN 'pass1' ELSE 'pass2' END AS pass,
       x_edge_result_type, sc_status, count(*) AS requests,
       sum(try_cast(sc_bytes AS bigint)) AS sc_bytes,
       min(concat(date, ' ', time)) AS first_req, max(concat(date, ' ', time)) AS last_req,
       count(DISTINCT sc_range_start) AS distinct_ranges
FROM "genome-portal-logs"."genome-portal-cf-access-logs"
WHERE dt IN ('2026/09/29')
  AND cs_uri_stem = '/projects/DEMO-0001/sample-53gib.bin'
  AND concat(date, ' ', time) BETWEEN '2026-09-29 05:08:00' AND '2026-09-29 05:51:00'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
-- Result 2026-09-29 (Athena workgroup genome-portal-ops, query 4ae14894-051b-40c5-b119-c859d77c01e6):
-- pass   result  status requests sc_bytes      first_req            last_req             distinct_ranges
-- pass1  Miss    206    7        56956411486   2026-09-29 05:11:34  2026-09-29 05:15:23  7
-- pass2  Hit     206    7        56918141574   2026-09-29 05:32:34  2026-09-29 05:37:44  7
-- Object: projects/DEMO-0001/sample-53gib.bin, 56,908,316,672 B, FULL_OBJECT CRC32 /yAtGQ== (verified by the split engine after each pass).
