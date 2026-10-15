# CloudFront data-transfer accounting for interrupted downloads (dev, 2026-10-02)

Question (customer, 2026-10-02): when a download is interrupted -- 10 GB received of a 30 GB object -- does CloudFront
count 10 GB or 30 GB as data transfer out (DTO)?

Answer: the bytes actually served. Verified by reconciling the data distribution's standard logs (v2, `sc_bytes`)
against Cost Explorer's billed usage quantity for the same days.

## Reconciliation (data distribution, viewer country JP = the test desktop's egress)

| Day (UTC)  | Log requests | Log bytes served                    | of which aborted requests (`x_edge_result_type=Error`) | Cost Explorer `JP-DataTransfer-Out-Bytes` | Diff   |
| ---------- | -----------: | ----------------------------------- | ------------------------------------------------------ | ----------------------------------------- | ------ |
| 2026-09-28 |           57 | 93,294,141,299 B = **86.887 GiB**   | 36 requests, 14.62 GB (13.6 GiB)                       | **86.8891**                               | +0.002 |
| 2026-09-29 |           46 | 129,425,564,473 B = **120.537 GiB** | 29 requests, 4.97 GB (4.6 GiB)                         | **120.5405**                              | +0.003 |

Cost Explorer's quantity unit is GB = 2^30 bytes (it matches the GiB column, not the decimal one). The match is
within 0.003 GiB on both days, so the billed quantity is the per-request `sc_bytes` sum -- including the partial bytes
of requests the viewer aborted. If aborted requests were billed at object/range size, 2026-09-28 would be off by
roughly 400 GiB (36 aborted requests on 1-12 GiB objects/parts).

Both days cost $0.00: the account's CloudFront always-free tier (1 TB/month) absorbed the transfer
(`JP-DataTransfer-Out-OBytes` $0.0002 is the only non-zero line). The 53 GiB cache test on 09-29 (2 x 56.9 GB) is
inside the 120.5 GiB figure.

## Per-request examples (from `aborted-requests-bytes.sql`)

| Time (UTC)          | Object / range                     | Requested length |  Bytes served | Served |
| ------------------- | ---------------------------------- | ---------------: | ------------: | -----: |
| 2026-09-28 06:11:22 | sample-1gib.bin (whole object)     |    1,073,741,824 |    63,071,850 |  5.9 % |
| 2026-09-28 13:51:23 | sample-12gib.bin, part 8-12 GiB    |    4,294,967,296 | 4,028,083,190 | 93.8 % |
| 2026-09-28 13:51:23 | sample-12gib.bin, part 0-8 GiB     |    8,589,934,592 | 2,868,545,247 | 33.4 % |
| 2026-10-02 01:24:27 | sample-12gib.bin (whole object)    |   12,884,901,888 |    12,054,314 |  0.1 % |
| 2026-10-02 01:25:15 | sample-53gib.bin, 4 parallel parts |    8,589,934,592 |    ~9 MB each |  0.1 % |

`x_edge_detailed_result_type` is `ClientCommError` or `ClientHungUpRequest` for all 89 rows -- viewer-side aborts.

## Implications for the portal

- Split engine (8 GiB parts x 4 in flight, 64 MiB flush chunks): an abrupt interruption re-fetches at most the
  unflushed tail of each in-flight part on resume, about 4 x 64 MiB = 256 MiB worst case, plus TCP in-flight data.
  Total DTO for a resumed download = object size + that overlap.
- S3 direct (first download) is billed the same way: bytes transferred, not object size.
- CloudFront may keep filling its cache from S3 after the viewer aborts; S3 -> CloudFront origin transfer is free, so
  this has no DTO cost (only S3 GET request fees, fractions of a cent).
- The flat-rate plan's usage allowance is measured as data transfer out as well (docs: "Data transfer" allowance;
  only traffic that passes the WAF web ACL counts). Once a distribution is on a flat-rate plan, CUR/Cost Explorer no
  longer carry usage metrics for it (PricingPlanManager "Monitoring and Managing Costs"), so the ops stack's
  log-based allowance alarms (`sc_bytes` sum) and CloudWatch `BytesDownloaded` are the usage sources.

Queries: `aborted-requests-bytes.sql` (per request), daily reconciliation:

```sql
SELECT dt, c_country, count(*) AS requests, sum(try_cast(sc_bytes AS bigint)) AS bytes,
       sum(CASE WHEN x_edge_result_type='Error' THEN try_cast(sc_bytes AS bigint) ELSE 0 END) AS aborted_bytes
FROM "genome-portal-logs"."genome-portal-cf-access-logs"
WHERE dt BETWEEN '2026/09/27' AND '2026/09/30' GROUP BY dt, c_country ORDER BY dt;
```

```bash
aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-09-27,End=2026-10-02 --granularity DAILY \
  --metrics UsageQuantity UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon CloudFront"]}}'
```
