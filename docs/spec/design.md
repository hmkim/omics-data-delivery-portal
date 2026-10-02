# 설계: 유전체 데이터 배포 포털 (Storage Browser + Cognito + S3 Access Grants + CloudFront)

요구사항 문서: `docs/spec/requirements.md`
확정 결정: D1-B(객체별 집계), D2-A(읽기 전용), D3-A(단일 다운로드 버튼), D4-A(1차 S3 직접, 임계값 설정 가능), D5-A(분할 임계값 1GiB + 다운로드 진행 중 세션 유지), D6-B(customer-managed auth 백엔드 = S3 Access Grants)

## 1. 아키텍처 개요

```
 브라우저 (React SPA, ko/en)
 ├─ Amplify Authenticator ── Cognito User Pool (이메일+PW, TOTP MFA, 자가가입 OFF)
 ├─ StorageBrowser (customer-managed auth 모드)
 │    ├─ listLocations ─────────► API  GET  /locations            (org → 위치 목록, DynamoDB)
 │    ├─ getLocationCredentials ► API  POST /credentials          (S3 Access Grants GetDataAccess: READ, Minimal, 1h)
 │    └─ 목록/검색 ─────────────► S3 (Access Grants 임시 자격증명으로 직접 ListObjectsV2)
 ├─ 커스텀 download 액션 ────────► API  POST /downloads            (경로 결정 + 서명 URL + 횟수 기록)
 │                                API  POST /downloads/{id}/renew (URL 갱신, 횟수 미증가)
 │                                API  POST /objects/status       (행 표시용 횟수·다음 경로)
 └─ 분할 다운로드 엔진 (Web Worker + File System Access API)
        ├─ 1차: S3 presigned URL (Access Grants 객체 자격증명으로 서명) ► S3 (서울)
        └─ 2차+: CloudFront Signed URL ───► CloudFront(Pro 정액제, OAC) ──► S3 (서울)

 웹 distribution `/api/*` (뷰어 IP·국가 헤더, x-origin-verify) ──► API Gateway HTTP API + Cognito JWT authorizer ──► Lambda (Node.js 22, TypeScript)
 S3 Access Grants (ap-northeast-2): instance ─ location s3://<bucket>/ → 위치 역할 ─ grant(prefix*, READ) → grantee 역할
 DynamoDB: orgs / object-downloads / audit-events      SSM: /genome-portal/{cf-threshold, url-ttl-seconds, split-threshold-bytes, single-object-limit-bytes}
 Secrets Manager: CloudFront 서명 RSA 개인키           CloudWatch: 대시보드·알람
```

CDK 스택(TypeScript, 리전 ap-northeast-2, WAF만 us-east-1):

| 스택                            | 리소스                                                                                                                                                                                                                                                       | 비고                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `genome-portal-auth`            | Cognito User Pool, App Client(SPA, PKCE, ID/Access 60분·Refresh 24시간, 토큰 폐기 ON), 그룹 `admins`, 사용자 속성 `custom:orgId`, `custom:lang`                                                                                                              | 자가 가입 OFF, MFA REQUIRED(파라미터로 OPTIONAL 전환). Refresh 24시간이 세션 상한(R1.5)                                                                                                |
| `genome-portal-data`            | 데이터 버킷(신규 또는 `dataBucketName` 파라미터로 기존 버킷 import), KMS 키, **S3 Access Grants 인스턴스·위치(`s3://<bucket>/`)·위치 IAM 역할**, DynamoDB 3개 테이블, SSM 파라미터                                                                           | 버킷 정책: OAC + Access Grants 위치 역할만 허용. 인스턴스는 계정·리전당 1개이므로 `accessGrantsInstanceArn` 파라미터로 기존 인스턴스 import 가능. 버킷은 인스턴스와 같은 리전이어야 함 |
| `genome-portal-waf` (us-east-1) | WAF Web ACL(CLOUDFRONT scope, 관리형 규칙 CommonRuleSet + RateBased 2,000 req/5min/IP)                                                                                                                                                                       | 정액제 필수. ARN을 SSM(us-east-1)에 기록, CDN 스택이 크로스리전 참조                                                                                                                   |
| `genome-portal-cdn`             | 데이터 distribution, OAC, Public Key + Key Group, 개인키 생성 Custom Resource → Secrets Manager, 캐시 정책 `CachingOptimized`, 응답 헤더 정책 `CORS-with-preflight`(관리형), 정액제 구독 `AWS::PricingPlanManager::Subscription`(설정 `flatRatePlan`, T1.6b) | Pro는 관리형 정책만 허용. 구독은 `PENDING_APPROVAL`로 생성되고 승인은 §7.2                                                                                                             |
| `genome-portal-api`             | HTTP API, JWT authorizer, Lambda 6개, IAM 역할 3개(**grantee 역할**·admin 역할·read-only 역할)                                                                                                                                                               | grantee 역할만 `s3:GetDataAccess`, admin 역할만 grant 생성·삭제. Lambda 역할에 S3 객체 직접 권한 없음(§2.5)                                                                            |
| `genome-portal-web`             | 정적 자산 버킷, 종량제 distribution(OAC; 기본 동작 → 정적 자산, `/api/*` → HTTP API 오리진에 `Authorization`·뷰어 IP/국가 헤더 전달 + 비밀 헤더 `x-origin-verify`), `BucketDeployment`, 런타임 설정 `config.json`                                            | 데이터 distribution과 분리. 포털과 API가 같은 오리진이라 브라우저 CORS 불필요                                                                                                          |
| `genome-portal-ops`             | CloudWatch 대시보드, 알람, 허용량·grant 정합성 집계 Lambda(일 1회), SNS 토픽                                                                                                                                                                                 | 국가별 지표는 CloudFront 표준 로그(S3) + Athena                                                                                                                                        |

모든 리소스 식별자는 `genome-portal-` 접두어, 태그 `Project=genome-portal`. 고객사명은 어디에도 넣지 않는다(브랜딩은 `config.json`의 `brand.name/logoUrl/primaryColor`로 주입).

## 2. 인증과 접근 격리

### 2.1 Cognito

- User Pool: 이메일을 username으로, `custom:orgId`(변경 불가, 관리자만 설정), `custom:lang`(`ko`|`en`).
- App Client: SPA, Authorization Code + PKCE, 토큰 폐기(RevokeToken) ON, 토큰 수명 ID/Access 60분, **Refresh 24시간**(한 로그인의 세션 상한, R1.5). 8시간이면 150GB를 50Mbps로 받는 6.7시간이 겨우 들어가고 그보다 느린 회선(해외 사용자 약 40%)은 중간에 끊기므로 하루로 잡았다. Cognito 기본값 30일까지 늘리지 않는 이유는 브라우저 로컬 저장소에 남는 리프레시 토큰의 노출 창을 하루로 묶기 위함이다.
- 무조작 60분 만료(R1.5)는 프런트 활동 타이머(`auth/session.ts`, §5.6)가 `signOut()`을 호출해 처리한다. 분할·zip 다운로드가 진행 중이면 타이머를 멈추고, 마지막 다운로드가 끝난 시점부터 다시 센다. ID/Access 토큰 갱신은 `fetchAuthSession()`이 리프레시 토큰으로 자동 수행하며 `api/client.ts`가 매 호출 전에 실행하므로, 방치된 다운로드의 `renew` 호출이 만료된 토큰으로 실패하지 않는다.
- 첫 로그인 임시 비밀번호 변경은 Cognito `FORCE_CHANGE_PASSWORD` 상태로 Authenticator가 기본 처리.
- 관리자 API는 JWT `cognito:groups`에 `admins` 포함 여부를 Lambda에서 확인.

### 2.2 Storage Browser 인증 모드 선택

Storage Browser의 세 모드 중 **customer-managed auth**를 쓰고, 그 백엔드(자격 증명을 만들어 주는 쪽)를 **S3 Access Grants(IAM grantee)**로 구현한다(D6-B).

- **Amplify Auth 모드 부적합**: 위치가 `defineStorage` 정적 규칙이라 조직→prefix 매핑을 런타임에 바꿀 수 없고, 기본 download가 15분 URL을 만든다.
- **IAM Identity Center + Access Grants 모드 부적합**: grantee가 Identity Center 디렉터리 사용자여야 하므로 외부 고객·해외 연구그룹 계정 발급이 어렵다(Transfer 웹 앱과 같은 제약).
- **customer-managed + Access Grants(IAM grantee)**: Storage Browser에는 `listLocations`/`getLocationCredentials` 두 함수만 제공한다. `getLocationCredentials({ scope, permission })`의 `scope`(`s3://bucket/prefix*`)와 `permission`(`READ`)은 Access Grants `GetDataAccess`의 `Target`/`Permission`과 같은 형식이라, 우리 API는 조직 검사 후 그대로 전달한다.

Access Grants를 택해 얻는 것:

1. **스코프 계산 위임**: 세션 정책 JSON을 우리가 만들지 않는다. `Privilege=Minimal`로 요청한 target(prefix 또는 단일 객체)만 허용되는 자격 증명을 S3가 만든다.
2. **자격 증명 수명 = URL 수명**: `DurationSeconds`를 명시(900~43,200초)하므로 S3 presigned URL의 실제 만료를 정확히 알 수 있다. 이전 설계처럼 Lambda 실행 역할 자격 증명으로 서명해 만료가 1시간에 못 미칠 위험이 없고, 필요하면 최대 12시간까지 늘릴 수 있다(설정값, §3).
3. **객체 단위 자격 증명**: `TargetType=Object`로 파일 하나에만 유효한 자격 증명을 받아 서명하므로, URL을 서명한 자격 증명이 유출돼도 다른 객체에 쓸 수 없다.
4. **배포 가능 prefix의 두 번째 원장**: grant는 등록된 prefix에만 존재한다. 조직 검사(DynamoDB)에 버그가 있어도 grant가 없는 prefix는 `GetDataAccess`가 거부한다.
5. **Identity Center 전환 여지**: 고객이 사내 디렉터리 연동을 원하면 인스턴스·위치·위치 역할은 그대로 두고 grantee만 디렉터리 사용자로 바꾼다.

대신 늘어나는 것: Access Grants 인스턴스·위치·위치 역할·grant 관리 API 호출, 다운로드 발급마다 `GetDataAccess` 1회(수백 ms), Access Grants 요청 과금(§9). 조직→prefix 판단은 여전히 우리 백엔드가 하므로 신뢰 경계는 이전 설계와 같다.

### 2.3 S3 Access Grants 구성

- **인스턴스**: `CfnAccessGrantsInstance`(Identity Center 연결 없음). 계정·리전당 1개.
- **위치**: `s3://<dataBucket>/` → `genome-portal-ag-location-role`. 위치는 버킷 1개만 등록한다(기본 위치 `s3://`는 계정의 모든 버킷을 포함하므로 쓰지 않음).
- **위치 역할** `genome-portal-ag-location-role` (`maxSessionDuration` 43,200초):
  - 신뢰 정책: 주체 `access-grants.s3.amazonaws.com`, 액션 `sts:AssumeRole`·`sts:SetSourceIdentity`, 조건 `aws:SourceAccount`=계정, `aws:SourceArn`=인스턴스 ARN.
  - 권한 정책(읽기만, D2-A):
    ```json
    {
      "Statement": [
        {
          "Sid": "ObjectRead",
          "Effect": "Allow",
          "Action": [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:GetObjectAcl",
            "s3:GetObjectVersionAcl",
            "s3:ListMultipartUploadParts"
          ],
          "Resource": "arn:aws:s3:::DATA_BUCKET/*",
          "Condition": { "ArnEquals": { "s3:AccessGrantsInstanceArn": "INSTANCE_ARN" } }
        },
        {
          "Sid": "BucketList",
          "Effect": "Allow",
          "Action": ["s3:ListBucket"],
          "Resource": "arn:aws:s3:::DATA_BUCKET",
          "Condition": { "ArnEquals": { "s3:AccessGrantsInstanceArn": "INSTANCE_ARN" } }
        },
        {
          "Sid": "Kms",
          "Effect": "Allow",
          "Action": ["kms:Decrypt"],
          "Resource": "DATA_KEY_ARN",
          "Condition": { "StringEquals": { "kms:ViaService": "s3.ap-northeast-2.amazonaws.com" } }
        }
      ]
    }
    ```
    `s3:AccessGrantsInstanceArn` 조건 때문에 이 역할은 Access Grants가 발급한 세션으로만 S3에 접근할 수 있다. 쓰기 액션이 없으므로 grant를 잘못 `READWRITE`로 만들어도 쓰기는 불가능하다(이중 방어).
- **grant**: 배포 위치(prefix) 1개당 1개. `Permission=READ`, `AccessGrantsLocationConfiguration.S3SubPrefix="<prefix>*"`, grantee = `genome-portal-grantee-role`(IAM). grant는 CDK가 아니라 **관리자 API가 런타임에 생성·삭제**한다(§7.3). 한도는 인스턴스당 grant 100,000개·위치 1,000개로 충분하다.
- **grantee 역할** `genome-portal-grantee-role`: `credentials`·`downloads`·`renew` Lambda의 실행 역할. `s3:GetDataAccess`(인스턴스 ARN), DynamoDB, SSM, Secrets Manager(CloudFront 개인키)만 허용. **S3 객체 권한은 없다** — 모든 S3 데이터 접근은 Access Grants 자격 증명으로만 한다.
- **admin 역할**: `s3:CreateAccessGrant`·`s3:DeleteAccessGrant`·`s3:ListAccessGrants`·`s3:GetAccessGrant`(인스턴스·grant ARN), Cognito Admin API, DynamoDB. `s3:GetDataAccess`는 없다(grant를 만드는 쪽이 데이터 자격 증명을 받을 수 없게 분리).

```ts
// web/src/storageBrowser.ts
export const { StorageBrowser, useView, useAction } = createStorageBrowser({
  config: {
    region: cfg.region,
    accountId: cfg.accountId,
    listLocations: () => api.get('/locations'), // {items:[{bucket,prefix,id,type:'PREFIX',permissions:['get','list']}]}
    getLocationCredentials: ({ scope, permission }) => api.post('/credentials', { scope, permission }),
    registerAuthListener: (onChange) =>
      Hub.listen('auth', (e) => {
        if (e.payload.event === 'signedOut') onChange();
      }),
  },
  actions: { default: { download: { ...defaultActionConfigs.download, handler: portalDownloadHandler } } },
  components: { DataTable: PortalDataTable }, // §5.1
  filePreview: { maxFileSize: () => 10 * 1024 * 1024, fileTypeResolver: portalFileTypeResolver }, // R3.4: 10MB 이하 .md5/.txt/.tsv/.csv/.md/.log → text, .pdf → pdf, 그 외(FASTQ/BAM/CRAM/VCF 등) → unsupported("다운로드하여 확인"). 미리보기 GET은 사용자 브라우징 자격 증명으로 직접 읽으며 다운로드 횟수에 세지 않는다
});
```

### 2.4 스코프 임시 자격 증명 (`POST /credentials`)

요청 `{ scope: "s3://bucket/prefix*", permission: "READ" }` (Storage Browser가 그대로 보냄).

1. `permission !== 'READ'` → 400. `scope` 파싱(`s3://` 접두어, 버킷 = 데이터 버킷, prefix는 `/`로 끝나고 `..`·빈 세그먼트 없음) 실패 → 400.
2. JWT의 `orgId`로 `orgs` 테이블 `ORG#<orgId>` / `LOC#<bucket>/<prefix>` 항목 존재 확인. 없으면 403 + 감사 이벤트 `ACCESS_DENIED`.
3. `GetDataAccess({ AccountId, Target: "s3://bucket/prefix*", Permission: "READ", Privilege: "Minimal", DurationSeconds: 3600, AuditContext: "user=<sub>;org=<orgId>;kind=browse" })`.
   - `AccessDenied`(grant 없음) → 403 + `ACCESS_DENIED{reason:'NO_GRANT'}` + 메트릭 `GrantMissing`(DynamoDB와 Access Grants 사이 드리프트 신호, §7.1).
4. 응답 `{ credentials: { accessKeyId, secretAccessKey, sessionToken, expiration } }`. Storage Browser는 만료 시 `getLocationCredentials`를 다시 호출한다.

`Minimal` READ 자격 증명은 해당 prefix에 한정된 `s3:ListBucket`과 prefix 아래 객체 `GetObject`만 허용한다. 다른 조직 prefix에 대한 목록·GET은 S3가 403으로 거부한다(통합 테스트 §10).

### 2.5 버킷·KMS 정책

- 퍼블릭 차단, SSE-KMS, 버전 관리.
- 버킷 정책 `Allow` 주체: CloudFront OAC(데이터 distribution ARN 조건), `genome-portal-ag-location-role`. 그 외 `Deny`(TLS 미사용 `Deny` 포함). 제공사 내부 업로드 파이프라인 주체는 `uploaderPrincipalArns` 파라미터로 `Deny` 예외에 포함한다. Lambda 역할은 어디에도 없다(S3 직접 접근 불필요).
- KMS 키 정책: 위치 역할 `kms:Decrypt`(`kms:ViaService` s3), CloudFront `kms:Decrypt`(`aws:SourceArn`=distribution ARN), 업로드 주체 `kms:GenerateDataKey`·`kms:Encrypt`.
- CORS(브라우저에서 S3 직접 fetch·Range 필요): `AllowedOrigins`=`*`, `AllowedMethods`=GET,HEAD, `AllowedHeaders`=`*`, `ExposeHeaders`=`Content-Length, Content-Range, ETag, x-amz-checksum-crc32, Accept-Ranges`. 포털 도메인으로 좁히지 않는 이유: S3는 특정 오리진 규칙에 대해 요청 오리진을 그대로 돌려주는데(+`Allow-Credentials: true`), CloudFront는 `Origin`을 캐시 키에 넣지 않으므로 그 응답이 다른 오리진에도 그대로 나간다(2026-09-29 dev 결함, acceptance §3-6). Pro 플랜은 관리형 응답 헤더 정책만 허용해 CloudFront 단에서 덮어쓸 수 없으니 S3가 모든 오리진에 같은 답(`*`)을 해야 한다. 접근 제어는 presigned/서명 URL이며 CORS가 아니므로 `*`가 노출하는 것은 없다.

## 3. 데이터 모델 (DynamoDB, 온디맨드, PITR ON)

| 테이블                           | PK                      | SK                      | 속성                                                                                                                                                             | 용도                                                                                          |
| -------------------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `genome-portal-orgs`             | `ORG#<orgId>`           | `META`                  | name, active, createdAt                                                                                                                                          | 조직                                                                                          |
|                                  | `ORG#<orgId>`           | `LOC#<bucket>/<prefix>` | bucket, prefix, label, assignedAt                                                                                                                                | 조직→위치 배정 (R2.4 다대다)                                                                  |
|                                  | `LOC#<bucket>/<prefix>` | `META`                  | bucket, prefix, `accessGrantId`, `grantScope`(`s3://bucket/prefix*`), createdAt                                                                                  | **위치 원장**: Access Grants grant 1개와 1:1. 어느 조직에도 배정되지 않으면 grant와 함께 삭제 |
| `genome-portal-object-downloads` | `OBJ#<bucket>/<key>`    | —                       | `count`(N), `lastAt`, `sizeBytes`, `checksumCrc32`                                                                                                               | 객체별 누적 횟수(D1-B)                                                                        |
| `genome-portal-audit-events`     | `DAY#<yyyy-mm-dd>`      | `TS#<iso>#<uuid>`       | type, userSub, orgId, bucket, key, sizeBytes, path(`S3`\|`CF`), mode(`single`\|`zip`\|`split`\|`command`), ip, country, downloadId, `matchedGrantTarget`, detail | 감사 (R7.1). TTL 400일 + 일별 S3 내보내기(Glacier IR)로 1년 이상 보관                         |
|                                  | `DL#<downloadId>`       | `META`                  | userSub, orgId, bucket, key, path, issuedAt, renewCount                                                                                                          | 갱신 시 경로 고정용(R4.6). TTL 7일                                                            |

GSI: `byUser`(PK userSub, SK TS) — 관리자 사용자별 조회(R6.3). `inverted`(PK sk, SK pk) — `LOC#…` 항목으로 배정 조직 역조회(위치 해제 시 참조 확인).

설정(SSM, Lambda가 60초 캐시):

- `/genome-portal/cf-threshold` = `1`(기본, D4-A). `0`이면 모든 다운로드 CloudFront(D4-B).
- `/genome-portal/url-ttl-seconds` = `3600`(R4.6). 허용 900~43,200. S3 경로는 `GetDataAccess.DurationSeconds`, CloudFront 경로는 `dateLessThan`에 같은 값을 쓴다. 1시간 초과는 URL 노출 창을 늘리는 정책 결정이므로 기본값을 바꾸지 않는다.
- `/genome-portal/split-threshold-bytes` = `1073741824`(1GiB, D5-A). File System Access API를 지원하는 브라우저에서 이 크기를 넘는 파일은 분할 엔진(§5.4)으로 받는다. 브라우저 기본 다운로드는 URL이 만료된 뒤 연결이 끊기면 처음부터 다시 받아야 하므로, 1시간 URL(R4.6)로 완료를 보장하기 어려운 크기부터 이어받기·자동 갱신이 있는 경로로 보내는 것이 목적이다. 1GiB는 10Mbps 회선에서 약 15분이라 그 아래는 다시 받아도 부담이 작다.
- `/genome-portal/single-object-limit-bytes` = `50000000000`(십진 50GB). CloudFront 단일 객체 한도에 맞춘 값으로, 이를 넘는 파일은 (a) zip에 포함 불가(R4.9), (b) File System Access API가 없는 브라우저에서는 명령 폴백(R5.6). 이전 초안의 50GiB(53,687,091,200)는 CloudFront 한도가 십진 GB일 경우 50.0~53.7GB 파일을 단일 요청으로 보내 실패시킬 수 있어 보수적으로 낮췄다.
- 두 임계값은 `genome-portal-web` 배포 시 `config.json`(`splitThresholdBytes`, `singleObjectLimitBytes`)에도 같은 값으로 기록된다. 서버는 `mode` 힌트에, 클라이언트 planner는 최종 판정과 행 배지에 쓴다(§4, §5.4).

## 4. 다운로드 경로 결정 (`POST /downloads`)

요청 `{bucket, key}` (zip은 파일별로 병렬 호출). 처리 순서:

1. **권한**: `orgs`에서 `(orgId, bucket, key가 속하는 prefix)` 확인. 실패 → 403 + `ACCESS_DENIED`.
2. **객체 자격 증명**: `GetDataAccess({ Target: "s3://bucket/key", TargetType: "Object", Permission: "READ", Privilege: "Minimal", DurationSeconds: urlTtl, AuditContext: "user=<sub>;org=<orgId>;dl=<downloadId>" })`. 응답의 `Credentials.Expiration`이 이 다운로드의 `expiresAt`, `MatchedGrantTarget`은 감사 기록. `AccessDenied` → 403 + `ACCESS_DENIED{reason:'NO_GRANT'}`.
3. **메타데이터**: 위 자격 증명으로 `HeadObject(ChecksumMode=ENABLED)` → `ContentLength`, `ChecksumCRC32`(full-object, 업로드 시 기록된 경우), `ETag`. 404면 횟수 기록 없이 404 반환. (`GetObjectAttributes`는 Access Grants READ 권한 집합에 없어 쓰지 않는다.) CloudFront 경로일 때도 이 단계까지는 동일하다 — S3 데이터 접근 통로를 Access Grants 하나로 고정하고 CloudTrail `GetDataAccess` 기록을 모든 다운로드에 남기기 위함.
4. **원자적 횟수 증가 (R4.5)**:
   ```ts
   const r = await ddb.update({
     Key: { pk: `OBJ#${bucket}/${key}` },
     UpdateExpression: 'ADD #c :one SET lastAt=:now, sizeBytes=:s, checksumCrc32=:crc',
     ReturnValues: 'ALL_OLD',
   });
   const prevCount = r.Attributes?.count ?? 0; // 첫 요청만 0
   const path = prevCount >= cfThreshold ? 'CF' : 'S3';
   ```
   `ALL_OLD`로 얻은 이전 값이 판정 기준이므로 동시 요청 중 정확히 하나만 `prevCount=0`이 된다.
5. **URL 발급 (유효 `urlTtl`, 기본 1시간, R4.6)**:
   - `S3`: 2단계 자격 증명으로 만든 `S3Client`에 `getSignedUrl(GetObjectCommand, {expiresIn: urlTtl})`. presigned URL의 실효 만료는 `min(expiresIn, 자격 증명 만료)`인데 둘이 같으므로 `expiresAt`이 정확하다. `ResponseContentDisposition=attachment; filename=...` 포함.
   - `CF`: `@aws-sdk/cloudfront-signer` `getSignedUrl({url:`https://${cfDomain}/${encodeKey}`, keyPairId, privateKey, dateLessThan: now+urlTtl})` canned policy. 개인키는 Secrets Manager에서 Lambda 초기화 시 1회 로드(캐시). Key Group 서명은 자격 증명과 무관하다.
6. **모드 힌트**: `sizeBytes > splitThreshold` → `mode:'split'`, 아니면 `'single'`. 서버는 브라우저 기능을 모르므로 크기 기준 힌트만 주고 최종 방식은 클라이언트 planner가 정한다(§5.4: File System Access API가 없는 브라우저는 `split`을 `sizeBytes > singleObjectLimit ? 'command' : 'single'`로 바꾼다). 단일 객체 한도를 넘는 파일이 CloudFront 경로여도 Range 파트(8GiB)는 각각 한도 미만이므로 CloudFront가 전송할 수 있다.
7. **감사**: `DOWNLOAD_ISSUED` 이벤트(`matchedGrantTarget` 포함) + `DL#<id>` 메타 기록.
8. 응답:
   ```json
   {
     "downloadId": "…",
     "url": "…",
     "path": "CF",
     "mode": "split",
     "expiresAt": "…",
     "sizeBytes": 161061273600,
     "checksumCrc32": "AbCd==",
     "count": 3,
     "filename": "sample02.bam"
   }
   ```

`POST /downloads/{id}/renew`: `DL#id`의 `path`를 읽어 **같은 경로**로 재발급(S3 경로는 `GetDataAccess` 재호출 후 재서명, CF 경로는 재서명), 횟수 미증가, `URL_RENEWED` 이벤트, `renewCount+1`. 다른 사용자가 호출하면 403.

`POST /objects/status` `{items:[{bucket,key}]}`(최대 100) → `BatchGetItem`으로 `count`, 계산된 `nextPath` 반환(R3.5). 방식 배지(분할·이어받기 / 명령어 다운로드)는 크기를 Storage Browser 목록이 이미 갖고 있으므로 클라이언트 planner가 행의 `size`와 현재 브라우저 기능으로 계산한다(`splitThresholdBytes`·`singleObjectLimitBytes`는 `config.json`, §3).

### 4.1 CloudFront 데이터 distribution 설정

- 오리진: 데이터 버킷, **OAC**(SigV4), OAI 미사용.
- 동작: GET/HEAD/OPTIONS, `TrustedKeyGroups=[portal-key-group]`(서명 필수), Viewer HTTPS only, 압축 OFF(바이너리).
- 캐시 정책: 관리형 **`CachingOptimized`** — 쿼리스트링·헤더·쿠키를 캐시 키에서 제외하므로 `Expires/Signature/Key-Pair-Id`가 달라도 히트(R4.7). Range 요청은 CloudFront가 오리진에서 조각 단위로 받아 캐시하므로 8GB 파트 반복 요청은 2회차부터 히트(R5.8).
- 응답 헤더 정책: 관리형 **`CORS-With-Preflight`**(Pro는 관리형만 허용; 커스텀 응답 헤더 정책은 Business 이상). 이 정책은 오리진이 보낸 CORS 헤더를 덮지 않고 없을 때만 `*`를 붙인다. 실측(2026-09-29 dev)으로는 S3가 `Origin`을 받아 CORS 헤더를 붙여 응답하고 그 응답이 `Origin` 없는 캐시 키로 캐시되므로, S3 버킷 CORS를 `*`로 두어 오리진과 무관한 답이 캐시되게 한다(§3). Origin 없이 채워진 캐시(curl/aria2c)는 이 정책이 `*`를 보탠다. 접근 제어는 서명 URL이 담당한다.
- Price Class All(N1), TLS 1.2_2021, HTTP/2+3, IPv6 ON.
- 표준 로깅(v2, S3로) ON — 국가·히트 분석용. 실시간 로그 OFF(정액제 미지원).
- WAF Web ACL 연결(N4).
- 정액제 Pro 플랜 연결: §7.2.

## 5. 프런트엔드

스택: Vite + React 18 + TypeScript, `aws-amplify@6`, `@aws-amplify/ui-react`, `@aws-amplify/ui-react-storage`, `react-i18next`, Web Worker(분할 다운로드), `idb`(재개 상태), `hash-wasm`(CRC32).

디렉터리:

```
web/
  public/amplify-storage-download/download-sw.js   # npx @aws-amplify/ui-react-storage copy-serviceworker public
  src/
    main.tsx                 # Amplify.configure(config.json 런타임 로드), ThemeProvider(brand), I18nextProvider
    App.tsx                  # <Authenticator hideSignUp> → <Portal/>
    storageBrowser.ts        # createStorageBrowser (§2.3)
    api/client.ts            # 매 호출 전 fetchAuthSession()으로 토큰 확보(만료 시 리프레시 토큰으로 자동 갱신), 재시도, credentials.expiration ISO→Date 변환, 리프레시 실패 → AUTH_EXPIRED
    auth/session.ts          # 무조작 60분 타이머, 다운로드 진행 중 정지, AUTH_EXPIRED 시 다운로드 일시정지·재로그인 유도 (§5.6)
    download/
      handler.ts             # portalDownloadHandler (ActionHandler)
      planner.ts             # 크기·브라우저 기능 → single|split|command
      splitEngine.ts         # 파트 스케줄러, Worker 4개, FS Access 쓰기, 재개, URL 갱신
      splitWorker.ts         # fetch(Range) → WritableStream 파트 기록, 진행률 postMessage
      checksum.ts            # 완료 후 CRC32 스트리밍 계산, S3 값과 비교
      commandFallback.ts     # aria2c / curl 명령 문자열 생성
      zip.ts                 # 다중 파일: 각 URL fetch → client-zip 스트림 → SW 경유 디스크 저장
    components/
      PortalDataTable.tsx    # 기본 DataTable + 횟수/다음 경로/분할 배지 열
      DownloadPanel.tsx      # 진행률·일시정지·재개·취소, 디스크 여유 안내, 예상 시간
      CommandDialog.tsx      # Safari/Firefox 명령 표시·복사
      Brand.tsx              # 로고·헤더
    i18n/{ko,en}.json        # displayText 사전 + 포털 문구
```

### 5.1 파일 행 표시 (R3.5)

`components.DataTable` 오버라이드. 기본 `DataTable` props(rows, columns)를 받아 현재 페이지의 파일 키를 모아 `POST /objects/status` 1회 호출(디바운스 300ms, 페이지 전환 시 재호출), 열 추가: `다운로드 횟수`, `다음 경로`(S3 직접 / CloudFront), `방식` 배지 — `planner.decide({sizeBytes: row.size})`가 `split`이면 "분할·이어받기", `command`면 "명령어 다운로드", `single`이면 표시 없음(R3.5). 같은 파일이라도 Chrome과 Safari에서 배지가 다를 수 있으며 그것이 의도다. 폴더 행은 빈 값.

### 5.2 커스텀 download 액션

Storage Browser의 기본 `download`는 사용자 임시 자격 증명으로 presigned URL을 만들어 앵커로 저장한다. 이 경로는 횟수 기록을 우회하므로 **핸들러를 교체**한다.

```ts
export const portalDownloadHandler: ActionHandler<DownloadHandlerData, void> = ({ data }) => {
  const result = (async () => {
    const issued = await api.post('/downloads', { bucket: data.bucket ?? cfg.bucket, key: data.key });
    const mode = planner.decide(issued); // 크기 × 브라우저 기능 → single|split|command (§5.4)
    toast(issued.path === 'CF' ? t('toast.viaCloudFront') : t('toast.viaS3'));
    if (mode === 'single' && issued.sizeBytes > cfg.splitThresholdBytes)
      toast(t('toast.noResumeInThisBrowser')); // R5.9
    if (mode === 'single') triggerAnchorDownload(issued.url, issued.filename);
    if (mode === 'split') await splitEngine.start(issued);
    if (mode === 'command') openCommandDialog(issued);
    return { status: 'COMPLETE' as const };
  })();
  return { result };
};
```

버튼은 하나(D3-A). 메뉴에서 upload/delete/copy/createFolder는 `actions.default`에서 제거해 숨긴다(권한도 없어 실패하지만 UI에서도 노출하지 않음, R2.5).

### 5.3 다중 파일 zip (R4.9)

`DownloadView`를 `useView('Download')`로 재구성한다. 선택 파일 중 `sizeBytes > singleObjectLimit`(50GB)인 항목은 제외하고 "개별 다운로드 필요(단일 객체 한도 초과)" 메시지를 표시(R4.9). 1GiB~50GB 파일은 zip에 포함할 수 있다. 나머지는 파일별 `POST /downloads` 병렬(동시 8) → 각 URL을 `fetch`해 `client-zip`으로 스트리밍 → `download-sw.js`(Amplify 제공 서비스 워커, scope `/amplify-storage-download/`)를 통해 디스크로 흘려 메모리 한도 없이 저장. 서비스 워커 미지원 시 Blob 폴백(2GB 이하 경고). 최대 5,000개. zip 진행 중에는 `activeDownloads`를 올려 무조작 타이머를 멈추지만(§5.6) zip 스트림에는 이어받기가 없으므로 중단·인증 만료 시 실패로 표시하고 다시 만들게 한다.

### 5.4 분할 다운로드 엔진 (R5)

선행 프로토타입(비공개)의 동작을 그대로 옮긴다. 핵심 계약:

- **planner** (`planner.decide({sizeBytes})`, 임계값 두 개는 `config.json`, §3):

  | 크기                                          | File System Access API 있음(Chrome, Edge) | 없음(Safari, Firefox)                                                                                      |
  | --------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | ≤ 1GiB (`splitThresholdBytes`)                | `single`                                  | `single`                                                                                                   |
  | 1GiB < 크기 ≤ 50GB (`singleObjectLimitBytes`) | `split`                                   | `single` + 토스트 "이 브라우저는 이어받기를 지원하지 않습니다. 연결이 끊기면 처음부터 다시 받습니다"(R5.9) |
  | > 50GB                                        | `split`                                   | `command`                                                                                                  |

  판정은 `'showSaveFilePicker' in window`. `split`은 저장 위치 선택 대화상자가 뜨므로 1GiB 초과 파일부터 Chrome UX가 "다운로드 폴더 자동 저장"에서 "위치 선택"으로 바뀐다(D5-A에서 수용). 행 배지(§5.1)도 같은 함수를 쓴다.

- **파트 계획**: `partSize = 8 GiB`, `parts = ceil(size/partSize)`, 동시 `min(4, parts)`. 각 파트 `Range: bytes=start-end`. 8GiB 이하 파일은 파트 1개라 병렬 이득은 없지만 이어받기(`receivedBytes`)와 URL 갱신은 같게 동작한다 — 1GiB~8GiB 구간에서 분할 엔진을 쓰는 이유는 병렬이 아니라 이어받기다.
- **저장 (D7 — 플랜 A + C 폴백)**: `showSaveFilePicker({suggestedName})`로 목적지 `FileSystemFileHandle`을 고른다. 그러나 목적지 `FileSystemWritableFileStream`에 **직접** 쓰면 재개가 깨진다 — 브라우저는 이 스트림을 swap 파일에 기록하고 `close()`가 성공한 순간에만 실제 파일로 교체하므로, `close()` 없이 페이지가 사라지면(새로고침·탭 닫기·크래시) IndexedDB의 진행 기록은 남고 데이터는 폐기되어 재개 후 CRC32 불일치가 난다(dev 인수 시나리오 5에서 실측, `docs/acceptance.md` §5). 그래서 파트 데이터는 두 저장소 중 하나에 둔다(`SplitRecord.storage`, 행에 `data-storage`):
  - **`opfs` (기본, 플랜 A)**: 파트마다 OPFS(`genome-portal-splits/<downloadId>/part-NNNN`)에 파일을 두고, 파트 워커가 `FileSystemSyncAccessHandle`로 **제자리에** 쓰고 64MiB마다 `flush()`한 뒤 "부터 N바이트가 내구적"이라고 엔진에 보고한다. 진행률(`receivedBytes`)은 이 보고값이므로 **디스크보다 앞서 기록될 수 없다**. 모든 파트가 끝나면 `merging` 단계에서 파트 파일을 순서대로 목적지 스트림에 `pipeTo`로 이어 붙여 1회 `close()`하고(병합 진행률 표시), 파트 파일을 삭제한다. 시작 시 `navigator.storage.persist()`를 요청한다. 디스크: OPFS(브라우저 프로필 = 시스템 드라이브)에 파일 크기 1×, 목적지에 1× (R5.7 안내 문구 `diskHintOpfs`). 로컬 I/O는 파일 크기의 3× 선형(쓰기·병합 읽기·병합 쓰기).
  - **`direct` (플랜 C 폴백)**: OPFS가 없거나(시크릿 창은 OPFS가 RAM 할당량이라 1GiB 이상 실패, T7.1 실측) `navigator.storage.estimate()`의 여유가 `파일 크기 + 256MiB`에 못 미치면 기존 방식대로 목적지 스트림에 `write({type:'write', position, data})`로 기록한다. 이때 진행 기록은 `receivedBytes`(swap에 쓴 양)와 **`committedBytes`(마지막 `close()`로 확정된 양)**를 구분해 저장하고, 비정상 종료 뒤 `load()`는 `committedBytes`로 되돌린다 — 재개는 항상 정확하지만 마지막 일시정지 이후 데이터는 다시 받는다. 시작 토스트로 이 한계를 알린다(`storage-fallback` 이벤트).
  - **런타임 전환**: `opfs` 다운로드 중 파트 쓰기가 `QuotaExceededError`면 `paused(STORAGE_QUOTA)`로 멈추고, 재개 시 내구 파트 바이트를 목적지에 복사해 1회 `close()`한 뒤 `direct`로 계속한다(`migrated`). 재개 전 파트 파일 크기와 기록을 대조해(브라우저 축출·사이트 데이터 삭제) 짧아진 파트는 다시 받고 사용자에게 잃은 양을 한 번 알린다(`reconciled`). 병합 중 파트가 사라지면 그 파트만 다시 받고 병합을 재시도한다.
    메모리는 어느 저장소든 파트당 스트리밍 chunk(64MiB) × 4로 1GB 이내.
- **재개(R5.4)**: IndexedDB `splits` 스토어에 `{downloadId, bucket, key, size, storage, merged, parts:[{idx,done,receivedBytes,committedBytes}], fileHandle}` 저장. 재방문 시 `running`/`merging`/`verifying`으로 남은 기록은 `paused(INTERRUPTED)`가 된다(`opfs`는 진행률 유지, `direct`는 `committedBytes`로 롤백). 재개는 `fileHandle.requestPermission()` 후 `done=false` 파트만 이어받기(`Range` 시작점 = `start + receivedBytes`; `opfs`는 워커가 파트 파일을 그 오프셋으로 `truncate`해 미확인 꼬리를 버린다). 병합 중 일시정지·중단은 파트 파일을 그대로 두고 재개 시 병합만 다시 한다. 일시정지는 `AbortController`.
- **URL 갱신(R5.5)**: `expiresAt - 5분` 타이머 또는 fetch 403 시 `POST /downloads/{id}/renew` → 새 URL로 남은 파트 재시작. 갱신은 횟수 미증가. renew 호출은 `api/client.ts`를 거치므로 만료된 ID 토큰은 리프레시 토큰으로 자동 갱신된다(§5.6). 리프레시까지 실패하면(`AUTH_EXPIRED`) 엔진은 전 파트를 `AbortController`로 멈추고 상태를 `paused(reason:'AUTH_EXPIRED')`로 IndexedDB에 저장한다 — 실패가 아니라 일시정지이며 재로그인 후 재개 대상이다(R1.5, R5.4).
- **체크섬(R5.3)**: 완료 후 파일을 다시 스트리밍 읽어 `hash-wasm` CRC32 계산 → `checksumCrc32`(base64)와 비교. S3에 값이 없으면 "검증 불가(업로드 시 체크섬 미기록)" 경고만 표시.
- **command 폴백(R5.6, 단일 객체 한도 초과 + File System Access API 없음)**:
  ```
  aria2c -x 4 -s 4 -k 8G --file-allocation=none -o "sample02.bam" "<signedUrl>"
  curl -L -C - -o "sample02.bam" "<signedUrl>"
  ```
  URL 만료 시각 안내와 "만료 시 이 화면에서 다시 발급" 버튼(renew 호출). 이 경우도 `POST /downloads`가 이미 1회를 기록했다.

### 5.5 i18n·브랜딩

`displayText`에 ko/en 사전을 통째로 넘기고 포털 고유 문구는 `react-i18next`. 초기 언어: `custom:lang` → 없으면 `navigator.language`. 헤더 토글로 전환. 테마는 `createTheme({primaryColor: brand.primaryColor})`, 로고는 `brand.logoUrl`(정적 버킷 `/brand/` 경로에 배포 시 업로드).

### 5.6 세션 유지와 무조작 타이머 (R1.5, 갭 3)

`auth/session.ts`:

- 활동 이벤트(`pointerdown`, `keydown`, `visibilitychange`→visible, API 호출)마다 `lastActivity`를 갱신한다. 1분 간격 검사에서 `now - lastActivity ≥ 60분`이고 `activeDownloads === 0`이면 `signOut()`을 호출한다(리프레시 토큰 폐기, 로컬 토큰·목록 제거, R1.6).
- `activeDownloads`는 분할 엔진(`running` 파트가 있는 다운로드 수)과 zip 스트림이 증감시킨다. 0보다 크면 만료 검사를 건너뛰고, 0으로 돌아오는 순간 `lastActivity = now`로 재설정해 "마지막 다운로드가 끝난 시점부터 60분"이 된다. 일시정지 상태의 다운로드는 `activeDownloads`에 포함하지 않는다(사용자가 멈춰 둔 것은 활동이 아니다).
- 토큰 갱신에 별도 타이머는 없다. `api/client.ts`가 매 요청 전 `fetchAuthSession()`을 호출하고, Amplify가 만료된 Access/ID 토큰을 리프레시 토큰으로 자동 교체한다. 리프레시 토큰은 24시간(§2.1)이고 사용해도 연장되지 않으므로 세션 상한은 로그인 후 24시간이다.
- 리프레시 실패(상한 도달, 관리자 `AdminUserGlobalSignOut`·비활성화, 다른 탭 로그아웃)는 `api/client.ts`가 `AUTH_EXPIRED`로 던진다. `session.ts`는 `splitEngine.pauseAll('AUTH_EXPIRED')`를 호출하고 진행 중 zip은 실패 처리한 뒤 배너 "세션이 끝났습니다. 다시 로그인하면 이어받습니다"를 띄우고 Authenticator로 돌아간다. 로그인 후 `DownloadPanel`이 IndexedDB의 `paused` 항목을 보여 주고 사용자가 재개한다(파일 핸들 권한 재요청 포함, R5.4).
- 다른 탭에서의 로그아웃은 `Hub` `signedOut` 이벤트로 같은 경로를 탄다(`registerAuthListener`가 Storage Browser에도 전파, §2.3).

## 6. 백엔드 Lambda (Node.js 22, TypeScript, esbuild)

| 함수           | 라우트                                                          | 실행 역할 | 비고                                                                                             |
| -------------- | --------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `locations`    | GET /locations                                                  | read-only | orgs Query → Storage Browser 형식 변환(`permissions:['get','list']`)                             |
| `credentials`  | POST /credentials                                               | grantee   | §2.4 `GetDataAccess`(prefix, READ, Minimal, 1h)                                                  |
| `downloads`    | POST /downloads                                                 | grantee   | §4 `GetDataAccess`(Object) + HeadObject + 횟수 + 서명                                            |
| `renew`        | POST /downloads/{id}/renew                                      | grantee   | 경로 고정 재발급                                                                                 |
| `objectStatus` | POST /objects/status                                            | read-only | BatchGetItem, 100개 상한                                                                         |
| `admin`        | POST /admin/{orgs\|locations\|users\|reset-count\|audit-export} | admin     | grant 생성·삭제(§7.3), Cognito AdminCreateUser 등. 1단계는 CLI(`tools/admin.ts`)가 이 API를 호출 |

공통: JWT authorizer(issuer=User Pool, audience=App Client). 응답에 `Cache-Control: no-store`. API는 웹 distribution의 `/api/*` 동작을 거쳐 호출되므로 클라이언트 IP·국가는 CloudFront 뷰어 헤더 `CloudFront-Viewer-Address`·`CloudFront-Viewer-Country`(관리형 오리진 요청 정책 `AllViewerAndCloudFrontHeaders-2022-06`)로 감사에 기록한다. API Gateway를 직접 호출해 이 헤더를 위조하는 것은 CloudFront가 붙이는 비밀 헤더 `x-origin-verify`(Secrets Manager `genome-portal/origin-verify`, Lambda가 검증)로 막고 403 처리한다. `GetDataAccess` 호출은 `AuditContext`에 `user=<sub>;org=<orgId>;dl=<downloadId>`를 넣어 CloudTrail 관리 이벤트와 우리 감사 테이블을 `downloadId`로 대조할 수 있게 한다. Access Grants 스로틀링(`SlowDown`/429)은 지수 백오프 2회 재시도 후 503.

## 7. 운영

### 7.1 모니터링 (R7)

- **대시보드**: CloudFront `BytesDownloaded`, `Requests`, `4xxErrorRate`(데이터 distribution); S3 직접 경로 전송량은 `DOWNLOAD_ISSUED` 이벤트의 `sizeBytes` 합(S3 경로)을 EMF 메트릭으로 발행; Lambda 오류율; API 403 건수; `GrantMissing` 건수.
- **캐시 히트율·국가(R7.2, R7.4)**: CloudFront 표준 로그(S3) → Glue 테이블 → Athena 일별 쿼리(`x-edge-result-type`, `c-country`, `sc-bytes`) → 결과를 CloudWatch 커스텀 메트릭으로 발행하는 일 1회 Lambda. (추가 메트릭 기능은 플랜별 제공 여부가 달라 로그 기반으로 통일.)
- **허용량(R7.3)**: 같은 일 1회 Lambda가 당월 `BytesDownloaded` 누적/50TiB를 계산해 `UsageAllowancePct` 메트릭 발행. 알람 50/80/100/200% → SNS(이메일).
- **grant 정합성**: 같은 일 1회 Lambda가 `ListAccessGrants`(grantee=grantee 역할) 결과와 `LOC#…/META` 집합을 비교해 `GrantDrift` 메트릭 발행(양쪽 어느 한쪽에만 있는 grant 수). 0이 아니면 알람.
- **알람(R7.5)**: `ACCESS_DENIED` 5분 합 ≥ 50; `downloads` Lambda 오류율 > 5%(5분); `GrantMissing` 5분 합 ≥ 1; `GrantDrift` > 0.

### 7.2 CloudFront Pro 정액제 연결 절차 (운영 문서에 수록)

1. `infra/config/<env>.json`에 `flatRatePlan: { tier: "PRO" }`를 두고 `genome-portal-cdn`을 배포한다. 스택이 `AWS::PricingPlanManager::Subscription`(distribution ARN + WAF Web ACL ARN)을 만들고, 유료 티어는 `PENDING_APPROVAL`로 생성된다(T1.6b, 2026-09-29 확인: CloudFormation 리소스 타입은 ap-northeast-2에도 등록돼 있고 dev에서 생성 성공). 이 상태에서는 과금도 플랜 적용도 없다. distribution이 Pro 미지원 기능(커스텀 캐시·오리진 요청·응답 헤더 정책, 실시간 로그, OAI, 다른 distribution과 공유된 WAF/Function)을 쓰면 `CreateSubscription`이 `ValidationException`으로 실패하고 스택이 롤백된다 — 그래서 데이터 distribution의 정책은 모두 관리형이고 CORS 균일성은 S3 버킷 CORS `*`로 확보한다(§5.4).
2. 사람이 승인한다(콘솔 Manage plan, 또는 `aws pricing-plan-manager approve-paid-subscription --region us-east-1 --arn <출력 FlatRatePlanSubscriptionArn> --if-match <eTag>`). 승인 즉시 비례 과금이 시작되고 현재 청구 주기 말까지 되돌릴 수 없다. 배포 역할에는 `CreateSubscription`만, 승인 권한(`ApprovePaidSubscription`)은 사람 계정에만 둔다.
3. Distribution ID를 AWS 어카운트팀에 공유(R7.6).
4. 2~3개월 뒤 `UsageAllowancePct`·히트율 추이로 Premium 전환·Origin Shield 필요성 판단. 티어 변경은 콘솔/CLI(`update-subscription`)로 먼저 하고 `flatRatePlan`을 실제 값으로 맞춰 배포한다 — CloudFormation은 티어 변경 업데이트를 거부한다.
5. 해지 시: 플랜 해지(청구 주기 말 적용; config에서 `flatRatePlan`을 빼고 배포해도 같은 해지 예약) → 다음 주기 후 스택 삭제. `cdk destroy`는 플랜이 붙어 있으면 distribution 삭제에서 실패하므로 teardown 문서에 순서 명시(N8). `PENDING_APPROVAL` 구독은 스택 삭제로 즉시 사라진다. Access Grants도 CFN 밖에서 만든 grant가 남아 있으면 위치·인스턴스 삭제가 실패하므로 `npm run admin -- location unassign --all`을 먼저 실행한다.

### 7.3 관리자 CLI (`tools/admin.ts`, R6.6)

```
npm run admin -- org create --id KU-lab --name "..."
npm run admin -- location assign --org KU-lab --bucket genome-delivery --prefix projects/P2026-0412/
npm run admin -- location unassign --org KU-lab --bucket genome-delivery --prefix projects/P2026-0412/
npm run admin -- location list [--org KU-lab]
npm run admin -- user create --email lee@ku.example --org KU-lab --lang en
npm run admin -- user disable|enable|delete --email ...
npm run admin -- count reset --bucket ... --key ...
npm run admin -- audit export --from 2026-10-01 --to 2026-10-31 --out audit.csv
```

관리자 Cognito 계정으로 로그인(SRP)해 얻은 ID 토큰으로 `/admin/*` 호출.

`location assign`(admin Lambda, 멱등):

1. `LOC#<bucket>/<prefix>` / `META` 조회. 없으면 `ListAccessGrants(GrantScope="s3://bucket/prefix*", GranteeType=IAM, GranteeIdentifier=granteeRoleArn)`로 기존 grant를 찾고, 없으면 `CreateAccessGrant(LocationId=버킷 위치, S3SubPrefix="prefix*", Permission=READ, Grantee=grantee 역할)` → `META` 저장(`accessGrantId`, `grantScope`).
2. `ORG#<orgId>` / `LOC#<bucket>/<prefix>` 항목 put.
3. 감사 이벤트 `LOCATION_ASSIGNED`.

`location unassign`:

1. `ORG#<orgId>` / `LOC#…` 삭제.
2. GSI `inverted`로 같은 `LOC#…`를 가진 다른 조직 조회. 없으면 `DeleteAccessGrant(accessGrantId)` + `META` 삭제(다른 조직이 남아 있으면 grant 유지).
3. 감사 이벤트 `LOCATION_UNASSIGNED`.

prefix는 `/`로 끝나야 하고 버킷 위치(`s3://<bucket>/`) 안에 있어야 한다. 중첩 prefix(예: `projects/P1/`과 `projects/P1/sub/`)는 grant 2개로 공존 가능하며 `GetDataAccess`는 요청 target에 가장 가까운 grant를 고른다.

### 7.4 시드 데이터 (N8)

`tools/seed.sh`: 1GiB·12GiB·53GiB 무작위 파일을 `aws s3 cp --checksum-algorithm CRC32`(full-object 체크섬 기록)로 `projects/DEMO-0001/`에 업로드, 조직 `demo`와 사용자 2명 생성, `location assign`으로 grant 생성.

## 8. 보안 검토 요약

- 정적 키 없음: 프런트는 Cognito 토큰 → Access Grants 임시 자격 증명(READ, 조직 prefix 한정, 1h)만 보유. CloudFront 개인키는 Secrets Manager, grantee 역할만 `GetSecretValue`.
- S3 데이터 접근 통로는 하나: Access Grants 위치 역할(`s3:AccessGrantsInstanceArn` 조건으로 Access Grants 경유 외 사용 불가). Lambda 역할에는 S3 객체 권한이 없고, 버킷 정책은 OAC·위치 역할·업로드 주체 외 `Deny`.
- 접근 판정 2중: DynamoDB 조직→위치 배정(누가) + Access Grants grant 존재(무엇이 배포 대상인가). 하나가 틀려도 다른 하나가 막는다.
- 쓰기 차단 2중: grant `READ` + 위치 역할에 쓰기 액션 없음(D2-A).
- URL을 서명한 자격 증명은 객체 1개·`urlTtl` 한정(`TargetType=Object`, `Minimal`). 자격 증명 만료 = URL 만료.
- grant 관리 권한(admin 역할)과 자격 증명 발급 권한(grantee 역할) 분리.
- 브라우저에 전달된 1시간 READ 자격 증명은 CLI로도 쓸 수 있어 포털 밖 직접 GET(횟수 미집계, S3 직접 전송)이 가능하다. Storage Browser 구조상 불가피하며 이전 STS 설계와 동일한 성질. 완화: prefix 한정·1시간, CloudTrail S3 데이터 이벤트(선택, 비용) 또는 S3 서버 접근 로그의 User-Agent·IP로 포털 외 접근 탐지.
- WAF 레이트 제한으로 서명 URL 무차별 대입·스크래핑 완화.
- 세션 상한 24시간(리프레시 토큰). 다운로드 진행 중에는 무조작 만료를 멈추므로 방치된 탭에 유효한 리프레시 토큰이 최대 24시간 남을 수 있다 — 방치된 장시간 다운로드를 끊지 않기 위한 정책 결정(D5-A). 토큰은 브라우저 로컬 저장소에만 있고 다운로드가 끝나면 60분 뒤 `signOut()`으로 폐기된다. 관리자는 `AdminUserGlobalSignOut`으로 즉시 무효화할 수 있다.
- 감사 로그에 파일 내용 미기록(키·크기·체크섬만, N9). CloudTrail `GetDataAccess` 관리 이벤트의 `auditContext`로 사용자·다운로드 ID 대조 가능.
- CORS: S3·CloudFront 모두 `*`(접근 제어는 presigned/서명 URL; 오리진별 답은 CloudFront 캐시와 충돌하고 Pro는 관리형 정책만 허용, §3).

## 9. 비용 산식 (운영 문서용, 월 기준)

- CloudFront Pro: $15 (전송·요청·WAF 포함).
- S3 직접 1차 다운로드 전송: `유일 다운로드 바이트 × $0.126/GB` — 예: 월 100TB 중 첫 다운로드 비중 30% 가정 시 약 30TB × 1,024 × $0.126 ≈ $3,900. 이 항목이 D4 재판단의 핵심 지표이며 `cf-threshold=0`으로 바꾸면 0이 된다.
- S3 Access Grants: 인스턴스·위치·grant 보유 비용 없음, **요청 건수 과금**. 호출 수 = 다운로드 발급 + 갱신 + 브라우징 자격 증명(사용자·위치당 1시간에 1회) ≈ 월 수천~수만 건 → 수 달러 이하. 정확한 단가는 S3 요금 페이지 "S3 Access Grants" 항목을 확인해 운영 문서에 기재한다.
- S3 요청·스토리지: 기존과 동일(포털로 인한 증분 미미).
- Lambda/API Gateway/DynamoDB/Cognito: 월 수만 요청 규모에서 $10 미만. Cognito MAU 50명 이내 무료.
- CloudFront 표준 로그 S3 + Athena: $5 미만.

## 10. 테스트 전략

- **단위(vitest)**: 경로 판정(`prevCount`/threshold 조합), `scope` 파서(정상·다른 버킷·`..`·`*` 유무·`/` 미종결 거부), `permission` READ 강제, `AuditContext` 포맷, planner 6칸 행렬(크기 3구간 × File System Access API 유무, 경계값 1GiB±1B·50GB±1B), 파트 계획(≤8GiB는 1파트·동시 1, 150GB는 19파트·동시 4), 명령 문자열, `session.ts` 상태기계(`activeDownloads` 0↔1 전환 시 타이머 정지·재설정, `AUTH_EXPIRED` → `pauseAll`), `location assign/unassign` 참조 카운트 상태기계(모킹된 S3Control).
- **통합(dev 계정, 전 스택 배포 + 시드)**:
  - `GetDataAccess(DurationSeconds=43200)`의 `Expiration`이 약 12시간 뒤인지 확인 — Lambda(역할 자격 증명)에서 호출해도 역할 체이닝 1시간 상한이 적용되지 않음을 검증. 실패하면 `url-ttl-seconds` 상한을 3,600으로 낮추고 설계 §2.2 항목 2를 수정한다.
  - `Minimal` prefix 자격 증명으로 다른 조직 prefix `ListObjectsV2`/`GetObject` → 403.
  - 등록되지 않은 prefix로 `POST /credentials`·`POST /downloads` → 403 `NO_GRANT`(DynamoDB에 배정만 임의로 넣은 상태).
  - S3 presigned URL이 `expiresAt` 직전 200, 직후 403.
  - `location unassign` 뒤 같은 prefix `GetDataAccess` 실패, 다른 조직이 남아 있는 위치는 grant 유지.
  - 동시 2요청 중 1건만 S3 경로, renew는 경로 고정.
  - CloudTrail `GetDataAccess` 이벤트에 `auditContext`가 기록되는지 확인.
- **e2e(Playwright)**:
  - Chromium: 기본 설정(분할 임계값 1GiB) 그대로인 dev 배포에서 12GiB 파일이 저장 대화상자 → 2파트 분할 다운로드로 시작되는지 확인 → 일시정지·재개·탭 종료 후 이어받기·CRC32 일치. 1GiB 파일은 일반 다운로드.
  - Chromium 세션 유지: 분할 진행 중 가짜 시계로 65분 무조작 → 로그아웃되지 않고 `renew`가 성공(ID 토큰이 리프레시된 것을 요청 헤더로 확인). 완료 후 60분 → `signOut()` 호출.
  - Chromium 인증 만료: 진행 중 `AdminUserGlobalSignOut`로 리프레시 토큰을 폐기 → 다음 `renew`에서 다운로드가 `paused(AUTH_EXPIRED)`로 남고 실패로 표시되지 않음 → 재로그인 후 재개 제안 → 완료·CRC32 일치.
  - Firefox: 12GiB는 일반 다운로드 + R5.9 안내 토스트 + 행 배지 없음; 53GiB는 command 다이얼로그 + "명령어 다운로드" 배지.
- **캐시 검증**: 같은 파일 2회 다운로드 후 표준 로그의 `x-edge-result-type`이 2회차 전 파트 `Hit`인지 Athena로 확인(R5.8).
