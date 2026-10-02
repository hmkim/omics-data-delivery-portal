# 운영 런북 -- 유전체 데이터 배포 포털

대상: 포털을 운영하는 개발·운영팀(관리자). 배포 절차는 `README.md`, 설계 근거는 `docs/spec/design.md`를 본다. 이 문서는 배포 뒤 반복해서 하는 일과, 문제가 생겼을 때 보는 절차만 담는다.

문서 안의 "확인 일자"는 AWS 공식 문서·요금 데이터를 실제로 열어 본 날짜다. 그 뒤 바뀔 수 있으니 분기마다 링크를 다시 연다.

---

## 1. CloudFront Pro 정액제 연결

### 1.1 사실 확인 (2026-09-28)

| 항목                                  | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 근거                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFormation/CDK로 정액제 플랜 연결 | **지원됨.** 리소스 타입 `AWS::PricingPlanManager::Subscription` (`PlanFamily: CloudFront`, `PlanTier: FREE\|PRO\|BUSINESS\|PREMIUM`, `ResourceArns`에 distribution ARN + WAF Web ACL ARN 필수). 단, **유료 티어는 `PENDING_APPROVAL` 상태로 만들어지고 CloudFormation이 승인하지 않는다.** 별도로 `ApprovePaidSubscription`(콘솔 또는 `aws pricingplanmanager approve-paid-subscription`)을 호출해야 과금·적용이 시작된다. 스택 업데이트로 티어·사용량 레벨은 바꿀 수 없고, 활성 구독을 삭제하면 청구 주기 말 해지가 예약된다. | [AWS::PricingPlanManager::Subscription](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pricingplanmanager-subscription.html)                                      |
| 플랜 관리 경로                        | 콘솔, AWS CLI, PricingPlanManager API(SDK) 모두 가능. 유료 플랜은 2단계(생성 → 승인) 활성화. 승인 즉시 잔여 일수 비례 과금, 다음 주기부터 월정액. **승인 후에는 현재 청구 주기가 끝날 때까지 취소·되돌리기 불가.**                                                                                                                                                                                                                                                                                                             | [Plan Management](https://docs.aws.amazon.com/PricingPlanManager/latest/UserGuide/plan-management.html)                                                                                        |
| 정액제 필수 조건                      | WAF Web ACL이 distribution에 연결돼 있어야 하며 플랜 사용 중에는 분리 불가. 실시간 로그·OAI·`ForwardedValues`·레거시 캐시 설정·Continuous deployment·Anycast IP 등은 미지원. 정액제 distribution에 연결된 WAF Web ACL·CloudFront Function은 다른 distribution과 공유 불가.                                                                                                                                                                                                                                                     | [CloudFront flat-rate pricing plans -- Unsupported features](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#pricing-plan-unsupported-features) |
| Pro 티어 기능 범위                    | 캐시 정책·오리진 요청 정책·응답 헤더 정책은 **관리형만** 사용 가능(커스텀 정책은 Business 이상). 캐시 동작 10개, WAF 규칙 25개, 표준 액세스 로그 포함. **Parquet 형식 액세스 로그는 플랜에 포함되지 않고 종량 과금**("Additional features that can affect your pricing plan" 항목).                                                                                                                                                                                                                                            | [Pricing plan features](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#pricing-plan-features)                                                  |
| 사용량 허용량                         | Pro: 월 50 TB 전송, 1,000만 요청. 하드 리밋 아님. 첫 스파이크는 3배까지 그 달 서비스에 영향 없음. 지속 초과는 2~3개월 이상 관찰 후 평가. 50/80/100% 도달 시 AWS가 이메일 통지.                                                                                                                                                                                                                                                                                                                                                 | [Monthly usage allowances](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#usage-allowance)                                                     |
| 플랜이 붙은 distribution 삭제         | 불가. 먼저 플랜 해지 → 유료 플랜은 청구 주기 말에 해지 적용 → 그 뒤 삭제. 비활성화(disable)만 하면 플랜 요금은 계속 나온다.                                                                                                                                                                                                                                                                                                                                                                                                    | [Deleting a distribution with a pricing plan](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#manage-your-pricing-plans)                        |

설계 §4.1·N4와의 대조: 관리형 `CachingOptimized`, 관리형 `CORS-With-Preflight` 응답 헤더 정책, OAC, 실시간 로그 OFF는 Pro 조건을 만족한다. **Pro는 캐시·오리진 요청·응답 헤더 정책 모두 관리형만 허용한다**(위 표). 2026-09-29 오전에 CORS 결함(acceptance §3-6) 대응으로 넣었던 커스텀 응답 헤더 정책 `genome-portal-data-cors`(오리진 override)는 Business 이상 기능이어서 T1.6b 채택과 함께 제거했다. 대신 데이터 버킷의 S3 CORS 규칙을 `AllowedOrigins: *`로 바꿔 S3가 어느 오리진에도 같은 헤더(`Access-Control-Allow-Origin: *`, Allow-Credentials 없음)를 돌려주게 했다 -- `CachingOptimized`는 `Origin`을 캐시 키에 넣지 않으므로 S3 응답이 오리진에 따라 달라지지 않아야 하고, 관리형 정책은 오리진 헤더를 덮지 않기 때문이다. 접근 제어는 서명 URL이므로 `*`가 노출하는 것은 없다(security-review #13). dev 검증 2026-09-29(`web/e2e/scripts/cors-probe.sh`): 포털 오리진·타 오리진·Origin 없음, Miss·Hit 모두 `access-control-allow-origin: *`. **주의 항목 하나**: T1.6이 표준 로깅 v2를 Parquet으로 켠다면 그 로그 전달은 플랜 밖 종량 과금이다. 첫 달 Cost Explorer에서 `CloudFront` 서비스의 로그 관련 항목을 확인하고, 비용이 의미 있으면 Parquet 대신 기본 텍스트(w3c) 포맷으로 바꾸고 Glue 테이블 정의를 맞춘다(§8 비용 항목 참조).

**T1.6b 채택(2026-09-29)**: 플랜 연결은 `genome-portal-cdn` 스택의 `AWS::PricingPlanManager::Subscription`(리소스 `FlatRatePlan`)이 만든다. `infra/config/<env>.json`의 `flatRatePlan: { "tier": "PRO" }`가 스위치이며, 없으면 리소스도 없다(종량제). CloudFormation은 유료 티어를 `PENDING_APPROVAL`로만 만들고 **승인은 사람이 한다**(아래 1.2). dev(123456789012)에는 PRO 구독이 `PENDING_APPROVAL`로 생성돼 있고 승인하지 않았다(과금 없음, 플랜 미적용). CloudFormation의 한계: (a) 티어·사용량 레벨 변경은 스택 업데이트로 거부된다 -- 콘솔/CLI로 먼저 바꾸고 config를 맞춘다(1.4); (b) 스택에서 리소스를 지우거나 `cdk destroy`하면 `PENDING_APPROVAL`은 즉시 삭제, `ACTIVE`는 청구 주기 말 해지가 예약되고 distribution 삭제는 그때까지 실패한다(§9); (c) 출력 `FlatRatePlanStatusAtDeploy`는 배포 시점 값이라 승인 뒤에는 다음 배포까지 `PENDING_APPROVAL`로 남아 있다 -- 현재 상태는 콘솔이나 `get-subscription`으로 본다.

### 1.2 연결 절차 (CDK 배포 → 승인)

1. `infra/config/<env>.json`에 `"flatRatePlan": { "tier": "PRO" }`를 두고 `genome-portal-cdn`을 배포한다(`tools/deploy.sh --env prod` 또는 `npx -w infra cdk deploy genome-portal-cdn -c env=prod --outputs-file cdn-outputs.json`). 출력 `FlatRatePlanSubscriptionArn`, `FlatRatePlanStatusAtDeploy`(= `PENDING_APPROVAL`), `DistributionId`를 적어 둔다.
   - `CreateSubscription`이 `ValidationException`으로 실패하면 distribution이 Pro 미지원 기능을 쓰고 있다는 뜻이다(커스텀 정책, 실시간 로그, OAI, 다른 distribution과 공유된 WAF/Function 등 -- 1.1 표). 스택은 자동 롤백되며 원인은 CloudFormation 이벤트의 상태 사유에 있다.
2. 사전 점검(콘솔 → CloudFront → Distributions → 해당 distribution): Security 탭에 WAF Web ACL `genome-portal-data-cdn-acl`, Origins는 OAC, Logging은 표준 로그만(Real-time 없음), Behaviors는 캐시 정책 `CachingOptimized`·응답 헤더 정책 `CORS-With-Preflight`(둘 다 관리형).
3. **승인**(여기서부터 과금, 되돌리기는 주기 말까지 불가):
   - 콘솔: distribution → **Manage plan** → 대기 중인 Pro 구독 승인. 또는
   - CLI(`aws-cli` 2.x 최신; 서비스명 `pricing-plan-manager`, 엔드포인트 `us-east-1`. 2.33.15에는 없다):
     ```bash
     aws pricing-plan-manager get-subscription --region us-east-1 --arn <FlatRatePlanSubscriptionArn> \
       --query '[subscription.status, eTag]' --output text
     aws pricing-plan-manager approve-paid-subscription --region us-east-1 \
       --arn <FlatRatePlanSubscriptionArn> --if-match <eTag>
     ```
     승인은 `pricingplanmanager:ApprovePaidSubscription` 권한이 있는 사람 계정으로만 한다(배포 역할에는 `CreateSubscription`만 있어도 된다).
4. 5분 안에 상태가 `ACTIVE`가 되는지 확인(`SYNC_IN_PROGRESS`는 2~5분). 승인 시점부터 잔여 일수 비례로 $15/월이 과금된다.
5. §2에 따라 Distribution ID를 AWS 어카운트팀에 공유하고, §12 기록 표에 일자를 남긴다.

### 1.3 CLI만으로 연결할 때 (CDK를 쓰지 않는 계정)

```bash
# 생성(PENDING_APPROVAL) -> 승인. ARN 두 개는 cdn/waf 스택 출력. 엔드포인트는 us-east-1.
aws pricing-plan-manager create-subscription --region us-east-1 \
  --plan-family CloudFront --plan-tier PRO --approval-mode MANUAL \
  --resource-arns <DistributionArn> <WebAclArn> \
  --query '[subscription.arn, eTag]' --output text
aws pricing-plan-manager approve-paid-subscription --region us-east-1 --arn <SubscriptionArn> --if-match <eTag>
```

CDK가 관리하는 환경에서 이 방법으로 만들면 스택 밖 구독이 되어 다음 `cdk deploy`가 두 번째 구독을 만들려다 실패한다. config의 `flatRatePlan`을 빼거나 CDK 경로(1.2)만 쓴다.

### 1.4 티어 변경·해지 (CloudFormation 밖에서 먼저)

- **업그레이드**(Pro → Business/Premium): 콘솔 Manage plan 또는 `update-subscription --plan-tier ... [--usage-level ...] --if-match <eTag>`. 즉시 적용·비례 과금. 그 다음 `flatRatePlan.tier`(Premium은 `usageLevel`도)를 실제 값으로 고쳐 커밋하고 배포한다 -- 템플릿이 실제와 같아지면 CloudFormation은 변경 없음으로 지나간다. config를 먼저 바꿔 배포하면 업데이트가 거부된다.
- **다운그레이드·해지**: 청구 주기 말 적용. 해지는 콘솔 또는 `cancel-subscription`; 되돌리기는 `cancel-subscription-change`. config에서 `flatRatePlan`을 지우고 배포하는 것도 해지 예약과 같다(리소스 삭제 = `CancelSubscription`). `PENDING_APPROVAL` 구독은 어느 쪽이든 즉시 사라진다.

---

## 2. Distribution ID를 AWS 어카운트팀에 공유 (R7.6)

플랜 연결 당일에 어카운트팀(담당 AM/SA) 메일 또는 공유 채널로 아래를 보낸다. 어카운트팀은 CloudFront 서비스팀과 사용량을 검토하고 플랜 조정을 안내한다.

- AWS 계정 ID, 리전(ap-northeast-2), distribution ID와 도메인
- 연결한 플랜(Pro, $15/월, 50 TB)과 연결 일자
- 예상 트래픽: 월 총 다운로드 약 139 TB(해외 41%), 그중 CloudFront 경로 비중은 첫 달 실측 후 갱신
- 특이사항: 파일 1개 최대 150 GB(Range 8 GiB 파트), 서명 URL, 반복 다운로드가 캐시 히트 대상
- 운영 연락처(관리자 메일 = `alertEmail`)

보낸 일자와 수신자를 §12 표에 기록한다. 플랜 티어를 바꿀 때마다 같은 내용을 다시 보낸다.

---

## 3. 월간 검토 (매월 1~3일)

대시보드 `genome-portal-ops`(CloudWatch)와 알람을 본다. 지표는 `opsDaily` Lambda가 01:00 KST에 전날 로그를 Athena로 집계해 발행한다.

| 지표                                                    | 보는 곳                                                                            | 판단                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UsageAllowancePct`                                     | 대시보드 / 알람 4개                                                                | 지난달 최대값. **2~3개월 연속 100% 초과**면 Premium 전환을 어카운트팀과 협의. 첫 달 3배 이내 스파이크는 무시. 200%가 반복되면 즉시 협의                       |
| `CacheHitRatioRequests`, `CacheHitRatioBytes`           | 대시보드                                                                           | 바이트 히트율이 낮으면(예: < 50%) 첫 다운로드가 S3 직접 경로로 빠지는지, 반복 다운로드가 실제로 있는지 확인. 히트율이 높고 허용량이 넉넉하면 현 구성 유지     |
| `OriginBytes`                                           | 대시보드                                                                           | 반복 다운로드가 많은데 오리진 전송이 큰 경우 Origin Shield 검토(Premium 전용). Pro에서는 선택지 없음                                                          |
| `BytesDomestic` / `BytesOverseas` (`c-country`=KR 기준) | 대시보드                                                                           | 해외 비중이 계획(41%)보다 크게 높고 히트율이 낮으면 Origin Shield 효과가 큼 → Premium 전환 근거                                                               |
| `BytesIssued{path=S3}`                                  | 대시보드                                                                           | S3 직접 1차 다운로드 전송량. §8 비용 산식의 핵심 입력. 이 값 × $0.126/GB가 CloudFront Premium 월정액을 넘기면 D4-B(`cf-threshold=0`) 또는 Premium 전환을 검토 |
| Access Grants 호출 수                                   | Cost Explorer(`Project=genome-portal`, 서비스 S3, 사용 유형 `APN2-Requests-Tier8`) | 월 수만 건이면 수 달러. 급증하면 브라우징 자격 증명 재발급 폭주(클라이언트 버그) 의심                                                                         |

Premium 전환 시 사용량 레벨(2026-09-28 확인, [Configurable usage allowances](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#usage-allowance)):

| 레벨          | 월 전송 | 월 요청 | 월정액  |
| ------------- | ------- | ------- | ------- |
| Premium(기본) | 50 TB   | 5억     | $1,000  |
| L2            | 75 TB   | 7.5억   | $1,450  |
| L3            | 125 TB  | 12.5억  | $2,250  |
| L4            | 200 TB  | 20억    | $3,500  |
| L5            | 350 TB  | 35억    | $6,000  |
| L6            | 600 TB  | 60억    | $10,000 |

업그레이드는 즉시 적용(비례 과금), 다운그레이드·해지는 다음 청구 주기부터. 현재 사용량이 대상 티어 허용량을 넘으면 다운그레이드가 거부될 수 있다.

D4 재판단(1차 S3 직접 vs 전량 CloudFront): 배포 후 **2~3개월째 월간 검토**에서 `BytesIssued{S3}` 비용과 CloudFront 허용량 여유를 함께 보고 결정한다. 전환은 SSM `/genome-portal/cf-threshold`를 `0`으로 바꾸면 끝이다(Lambda 60초 캐시, 코드 변경 없음). 예정일을 §12 표에 적어 둔다.

---

## 4. 비용 산식 (월)

| 항목                                      | 산식 / 단가                                                                                                                                                                  | 근거·확인 일자                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFront Pro                            | $15 고정(전송·요청·WAF·표준 로그 CloudWatch 인제스트 포함, 초과 과금 없음)                                                                                                   | flat-rate 문서, 2026-09-28                                                                                                                                                                                                                                                                                                                                                                                                         |
| S3 직접 1차 다운로드 전송                 | `BytesIssued{S3}`(GB) × **$0.126/GB**(서울 → 인터넷, 첫 10 TB 구간). 예: 139 TB 중 유일 다운로드 30% ≈ 42.7 TB × 1,024 × $0.126 ≈ **$5,500**                                 | 설계 §9. 실측 단가는 배포 48시간 후 Cost Explorer로 대조(T8.4). 월 10 TB 초과 구간은 단가가 내려가므로 실제는 이보다 조금 낮다                                                                                                                                                                                                                                                                                                     |
| S3 Access Grants 요청                     | **$0.03 / 1,000 요청**(`GetDataAccess` 포함, ap-northeast-2, 사용 유형 `APN2-Requests-Tier8`). 인스턴스·위치·grant 보유 비용 없음. Delete 계열은 $0. 예: 월 20,000회 → $0.60 | AWS Price List(공식 요금 데이터) `AmazonS3` 오퍼 ap-northeast-2, 발행 2026-09-26, 확인 2026-09-28: [index.json](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-northeast-2/index.json). [aws.amazon.com/s3/pricing](https://aws.amazon.com/s3/pricing/)의 표는 스크립트로 그려져 텍스트로는 확인하지 못했으므로, 브라우저에서 "Security & buckets" 탭 → "S3 Access Grants" 항목으로 한 번 더 대조한다 |
| Access Grants 호출 수 추정                | 다운로드 발급(`/downloads`) + 갱신(`renew`, S3 경로만 `GetDataAccess` 재호출) + 브라우징 자격 증명(`/credentials`, 사용자·위치당 1시간에 1회)                                | 설계 §2.4, §4                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CloudFront 표준 로그                      | 로그 S3 저장 + Athena 스캔 $5 미만. **Parquet 로그 전달은 플랜 외 과금**(첫 달 확인)                                                                                         | flat-rate 문서 "Additional features", 2026-09-28                                                                                                                                                                                                                                                                                                                                                                                   |
| Lambda / API Gateway / DynamoDB / Cognito | 월 수만 요청 규모에서 $10 미만. Cognito MAU 50명 이내 무료                                                                                                                   | 설계 §9                                                                                                                                                                                                                                                                                                                                                                                                                            |
| S3 스토리지·요청                          | 기존과 동일(포털 증분 미미). Pro 플랜의 S3 Standard 50 GB 크레딧이 계정 전체에 적용                                                                                          | flat-rate 문서 "Amazon S3 storage"                                                                                                                                                                                                                                                                                                                                                                                                 |

월 합계(예시) ≈ $15 + S3 직접 전송(수천 달러, 유일 다운로드 비중에 비례) + $10 미만 + $5 미만 + Access Grants $1 미만. 즉 **S3 직접 1차 다운로드 전송이 전체 비용을 결정한다.** 이 항목이 Premium 월정액보다 커지면 §3의 D4 재판단으로 간다.

Cost Explorer 필터: 태그 `Project=genome-portal`. 새 태그 값이 필터에 나타나기까지 최대 24시간, 집계까지 24~48시간 걸리므로 배포 직후의 $0은 실제 값이 아니다.

---

## 5. 커스텀 도메인과 TLS

- `infra/config/<env>.json`에 `portalDomain`(+ `hostedZoneId`)을 주면 포털은 `<portalDomain>`, 데이터 distribution은 `data.<portalDomain>`으로 배포되고 ACM(us-east-1) 인증서와 `TLS_V1_2_2021` 최소 정책이 적용된다(N2).
- `portalDomain`이 없으면 `*.cloudfront.net` 기본 도메인을 쓰고 **최소 TLS 버전을 설정할 수 없다**(CloudFront 제약). 개발 환경만 허용하고 운영 환경에는 반드시 도메인을 준다.
- Pro 플랜은 apex 도메인 1개를 포함하며 Route 53 호스팅 존을 플랜에 붙이면 존 비용도 플랜에 포함된다(ALIAS 레코드 권장). 존을 붙이지 않으면 Route 53은 종량 과금.
- 인증서 갱신은 ACM 자동. DNS 검증 레코드를 지우지 않는다.
- 도메인을 바꾸면 S3 CORS `AllowedOrigins`(data 스택)와 `config.json`이 함께 바뀌므로 `data → web` 재배포가 필요하다.

---

## 6. 알려진 제약 (사용자 안내용)

| 제약                                        | 설명                                                                                                                                                                   | 안내                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Safari·Firefox 이어받기 없음 (R5.9)         | File System Access API가 없어 1 GiB 초과~50 GB 이하 파일은 브라우저 기본 다운로드. URL(1시간) 만료 뒤 연결이 끊기면 처음부터 다시 받아야 함                            | 포털이 시작 시 토스트로 안내. 대용량은 Chrome/Edge 권장. 50 GB 초과는 aria2c/curl 명령 폴백                        |
| 브라우저 자격 증명의 포털 외 사용 (설계 §8) | 브라우징용 1시간 READ 자격 증명(prefix 한정)은 CLI로도 쓸 수 있어 포털 밖 직접 GET이 가능(횟수 미집계, S3 직접 전송)                                                   | Storage Browser 구조상 불가피. 완화: prefix 한정·1시간·`Minimal`. 필요 시 S3 서버 접근 로그의 User-Agent/IP로 탐지 |
| 세션 상한 24시간                            | 리프레시 토큰 24시간. 다운로드 중이어도 넘기면 재로그인 필요(분할 다운로드는 일시정지로 보존되어 재로그인 후 이어받기)                                                 | 150 GB급은 1 Gbps에서 약 30분이므로 실사용에서 걸리는 일은 드묾                                                    |
| 로그인 실패 이벤트 위치                     | 감사 테이블에는 로그인 **성공**만 기록된다. 실패는 CloudTrail의 Cognito 이벤트 `InitiateAuth` / `RespondToAuthChallenge`(errorCode `NotAuthorizedException` 등)로 조회 | CloudTrail 콘솔 → Event history → Event source `cognito-idp.amazonaws.com`                                         |
| 단일 객체 50 GB                             | zip 일괄 다운로드에 포함 불가. 분할 다운로드나 명령 폴백만                                                                                                             | 포털이 제외 메시지 표시                                                                                            |
| 미리보기                                    | 텍스트 10 MB 이하와 PDF만                                                                                                                                              | FASTQ/BAM/VCF는 다운로드 후 확인                                                                                   |

---

## 7. 알람 대응 (10개, SNS → `alertEmail`)

알람 이름은 모두 `genome-portal-` 접두어. 대시보드 `genome-portal-ops` 상단 위젯에서 상태를 한눈에 본다.

| 알람                               | 조건                                                                | 대응                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-allowance-50pct` / `-80pct` | 당월 CloudFront 전송 ≥ 50% / 80%                                    | 정상 범위. 월간 검토 때 추이 확인. 80%가 월 중순 이전이면 그 달 100% 초과 예상 → 어카운트팀에 미리 알림                                                                                                                                                                                                                                                                                                                                                     |
| `usage-allowance-100pct`           | ≥ 100%                                                              | 서비스 영향 없음(초과 과금 없음). 2~3개월 연속이면 Premium 협의(§3). 첫 달이면 스파이크(3배 이내)로 봄                                                                                                                                                                                                                                                                                                                                                      |
| `usage-allowance-200pct`           | ≥ 200%                                                              | 비정상 트래픽 가능성. Athena로 `c-ip`·`cs-uri-stem` 상위 조회, WAF 레이트 제한 로그 확인. 스크래핑이면 해당 사용자 `user disable` + `AdminUserGlobalSignOut`. 정상 수요면 즉시 어카운트팀 협의                                                                                                                                                                                                                                                              |
| `access-denied-5min`               | 5분 내 `ACCESS_DENIED` ≥ 50                                         | `audit export`로 당일 이벤트를 뽑아 `reason`(`NOT_ASSIGNED`/`NO_GRANT`/`BAD_SCOPE`/`NOT_OWNER`)과 `userSub`·`ip` 분포 확인. 한 사용자 집중 → URL 조작 시도, 사용자 비활성화. `NO_GRANT` 다수 → 아래 `grant-missing` 절차. 배포 직후면 위치 배정 누락 가능                                                                                                                                                                                                   |
| `downloads-error-rate`             | `downloads` Lambda 오류율 > 5% (5분)                                | CloudWatch Logs `/aws/lambda/genome-portal-downloads` 오류 확인. Access Grants `SlowDown`(503)이면 잠시 후 회복. Secrets Manager/SSM 권한 오류면 최근 api 스택 변경 롤백                                                                                                                                                                                                                                                                                    |
| `grant-missing`                    | 배정된 위치에 대해 `GetDataAccess`가 거부됨 (5분 합 ≥ 1)            | DynamoDB에는 배정이 있는데 Access Grants에 grant가 없는 상태. `npm run admin -- location list`의 `grant` 열이 `-`인 위치를 찾아 `location assign`을 다시 실행(멱등, 기존 grant 탐색 후 없으면 생성). 그래도 반복되면 `aws s3control list-access-grants --account-id <계정> --region ap-northeast-2`로 grantee 역할 ARN·scope 대조                                                                                                                           |
| `grant-drift`                      | 일일 대조에서 `LOC#…/META`와 `ListAccessGrants` 결과가 불일치 (> 0) | (1) `npm run admin -- location list` (2) `aws s3control list-access-grants --account-id <계정> --region ap-northeast-2 --query "AccessGrantsList[?Grantee.GranteeIdentifier=='<grantee 역할 ARN>'].[AccessGrantId,GrantScope]"` (3) 원장에만 있으면 `location assign` 재실행, Access Grants에만 있으면 `aws s3control delete-access-grant --access-grant-id <id>` (다른 조직이 쓰는지 `location list`로 먼저 확인). 다음 `opsDaily` 실행 후 0으로 복귀 확인 |
| `ops-daily-failed`                 | `opsDaily` Lambda 오류                                              | 로그 `/aws/lambda/genome-portal-ops-daily`. Athena 실패면 전날 로그 파티션 존재 여부(`s3://genome-portal-cf-logs-<계정>/…`)와 워크그룹 `genome-portal-ops` 결과 버킷 확인. 아카이브 실패면 `genome-portal-audit-archive-<계정>` 권한. 수동 재실행: `aws lambda invoke --function-name genome-portal-ops-daily --payload '{}' out.json`                                                                                                                      |
| `api-5xx`                          | HTTP API 5xx ≥ 5 (5분)                                              | API Gateway 액세스 로그와 Lambda 로그 확인. JWT authorizer 설정 변경 직후면 `auth`/`api` 스택 재배포                                                                                                                                                                                                                                                                                                                                                        |

공통: 알람이 `INSUFFICIENT_DATA`가 아닌 `ALARM`으로 남아 있으면 조치 후 원인 지표가 정상으로 돌아왔는지 대시보드에서 확인한다. `treatMissingData=notBreaching`이므로 데이터가 없어서 울리는 일은 없다.

---

## 8. 사용자·조직·횟수 관리 (admin CLI)

설정: `tools/admin.config.json`(`tools/admin.config.example.json` 복사, auth 스택 출력 `UserPoolId`·`ClientId`, web 스택 출력 `PortalUrl`). 로그인은 `admins` 그룹의 Cognito 계정으로 SRP + TOTP. ID 토큰은 `~/.genome-portal/token.json`(0600)에 1시간 캐시되고 만료되면 다시 묻는다. `--login`으로 강제 재로그인.

### 8.1 신규 조직·사용자 (인수 시나리오 1)

```bash
npm run admin -- org create --id KU-lab --name "Korea University lab"
npm run admin -- location assign --org KU-lab --bucket <데이터 버킷> --prefix projects/P2026-0412/
npm run admin -- user create --email lee@ku.example --org KU-lab --lang en
```

- `location assign`은 멱등이다. 같은 prefix를 다른 조직에도 배정하면 grant는 하나를 공유한다(R2.4).
- `user create`는 Cognito가 임시 비밀번호를 메일로 보낸다. 첫 로그인에서 비밀번호 변경과 TOTP 등록이 강제된다.
- 관리자 계정은 Cognito 콘솔에서 `admins` 그룹에 넣는다(CLI에는 그룹 조작이 없다 -- 관리자 권한 부여는 콘솔에서만 하도록 의도).

### 8.2 비활성화·재활성화·삭제

```bash
npm run admin -- user disable --email lee@ku.example   # 즉시 로그인 불가, 진행 중 분할 다운로드는 다음 갱신 때 일시정지
npm run admin -- user enable  --email lee@ku.example
npm run admin -- user delete  --email lee@ku.example   # 감사 이벤트는 남는다(userSub 기준)
npm run admin -- org disable --id KU-lab               # 조직 전체 403, 위치 배정은 유지
```

즉시 세션을 끊어야 하면 `aws cognito-idp admin-user-global-sign-out --user-pool-id <풀> --username <이메일>`을 추가로 실행한다(리프레시 토큰 폐기).

### 8.3 위치 해제

```bash
npm run admin -- location unassign --org KU-lab --bucket <버킷> --prefix projects/P2026-0412/
npm run admin -- location list                          # 남은 조직·grant 확인
```

마지막 조직이 해제되면 grant도 삭제된다. 다른 조직이 남아 있으면 grant는 유지된다.

### 8.4 다운로드 횟수 초기화 (R6.4, 재제공 요청)

```bash
npm run admin -- count reset --bucket <버킷> --key projects/P2026-0412/sample01.g.vcf.gz
```

다음 다운로드가 다시 S3 직접 경로가 된다. 초기화 자체가 `COUNT_RESET` 감사 이벤트로 남는다.

### 8.5 감사 로그 내보내기 (R6.3)

```bash
npm run admin -- audit export --from 2026-10-01 --to 2026-10-31 --out audit-2026-10.csv
```

일자별(UTC) 파티션을 순서대로 호출해 CSV(열: at,type,userSub,orgId,bucket,key,sizeBytes,path,mode,ip,country,downloadId,reason)로 합친다. 400일보다 오래된 이벤트는 DynamoDB TTL로 빠지므로 `genome-portal-audit-archive-<계정>`(Glacier Instant Retrieval, `opsDaily`가 매일 내보냄)에서 꺼낸다. 파일 내용은 어디에도 기록되지 않는다(N9).

### 8.6 임계값 변경

SSM 파라미터 4개(`/genome-portal/cf-threshold`, `url-ttl-seconds`, `split-threshold-bytes`, `single-object-limit-bytes`)는 Lambda가 60초 캐시한다. `split-threshold-bytes`·`single-object-limit-bytes`는 `config.json`에도 있어 SPA가 판정에 쓰므로, 바꿀 때는 `contract/src/index.ts`의 값을 고치고 `data`(SSM)·`web`(config.json) 스택을 재배포해 두 값이 같게 유지한다. `cf-threshold`·`url-ttl-seconds`는 서버만 읽으므로 SSM 값만 바꿔도 되지만, 다음 배포에서 코드 상수로 되돌아가지 않게 contract 값도 맞춘다.

---

## 9. Teardown 순서 (N8)

`tools/teardown.sh --env <env> [--dry-run] [--yes]`가 아래를 순서대로 수행한다. `--dry-run`은 AWS를 호출하지 않고 순서만 출력한다.

1. `npm run admin -- location unassign --all` -- 런타임에 만든 grant를 모두 지운다. 남아 있으면 Access Grants 위치·인스턴스 삭제가 실패해 `data` 스택이 `DELETE_FAILED`가 된다.
2. **정액제 플랜 확인 프롬프트** -- 데이터 distribution에 플랜이 붙어 있으면 중단. 콘솔에서 플랜 해지 → 청구 주기 말 적용 → 그 뒤 재실행(`--skip-unassign` 가능). `PENDING_APPROVAL` 상태(승인 전)면 즉시 취소된다.
3. `cdk destroy` 역순: `ops → web → api → data → cdn → waf → auth`.
4. RETAIN 리소스 수동 삭제 안내 출력: 데이터 버킷(버전 포함 비우기 → 삭제; import한 버킷이면 건너뜀), 감사 아카이브 버킷, CloudFront 로그 버킷, KMS 키(`alias/genome-portal-data`, 삭제 예약 7~30일 -- 버킷을 먼저 비운다). 임포트한 Access Grants 인스턴스는 삭제하지 않는다.

플랜 해지에서 삭제 가능까지 최대 한 달이 걸리므로, 종료가 예정되면 **먼저 플랜을 해지**하고 나머지는 그대로 운영한다(해지 뒤에도 주기 말까지 플랜 혜택은 유지된다).

---

## 10. Storage Browser 로드맵 재검토 메모

- 현재 구조에서 브라우저 미리보기·목록은 Access Grants 자격 증명으로 S3를 직접 읽고, 다운로드만 포털 API(`/downloads`)가 경로를 정한다. Storage Browser가 **byte-range GET(부분 다운로드)** 이나 **CloudFront 경유 캐시 읽기**를 자체 지원하게 되면 분할 엔진(§5.4)·커스텀 download 액션의 상당 부분을 걷어낼 수 있다.
- 재검토 시점: `@aws-amplify/ui-react-storage` 메이저 릴리스마다, 그리고 6개월마다. 확인 항목: (1) 다운로드 핸들러가 외부 URL(서명 URL)을 받을 수 있는가 (2) Range 요청·이어받기 API가 있는가 (3) `getLocationCredentials` 외에 URL 기반 접근 모드가 있는가.
- 채택 조건: 이어받기(R5.4)와 CRC32 검증(R5.3), 1차 S3/2차 CloudFront 규칙(R4)이 유지돼야 한다. 셋 중 하나라도 깨지면 현 구조 유지.
- S3 Access Grants 쪽 변화도 함께 본다: `GetObjectAttributes`가 READ 권한 집합에 들어오면 `HeadObject` 대신 쓸 수 있다.

---

## 11. 정기 점검 목록

| 주기            | 할 일                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| 매일(자동)      | `opsDaily` 성공 여부 -- 실패 시 `ops-daily-failed` 알람                                                      |
| 매주            | 알람 상태, `access-denied` 이벤트 상위 사용자 확인                                                           |
| 매월 1~3일      | §3 월간 검토, Cost Explorer 대조(§4)                                                                         |
| 분기            | 이 문서의 링크·단가 재확인, cdk-nag 억제 목록(`infra/lib/nag-suppressions.ts`) 재검토, 관리자 계정 목록 정리 |
| 배포 후 2~3개월 | D4 재판단(§3), Premium/Origin Shield 필요성 판단, 어카운트팀과 사용량 검토                                   |

---

## 12. 기록

| 항목                                        | 값                          |
| ------------------------------------------- | --------------------------- |
| Pro 플랜 연결 일자 / 계정 / Distribution ID | (운영 배포 시 기입, T8.3)   |
| 어카운트팀 공유 일자 / 수신자               | (운영 배포 시 기입)         |
| 첫 Cost Explorer 대조 일자와 실측 단가      | (배포 48시간 후 기입, T8.4) |
| D4 재판단 예정일                            | (배포일 + 2~3개월)          |
| 단가·문서 확인 일자                         | 2026-09-28 (이 문서 초판)   |
