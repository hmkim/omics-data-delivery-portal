# 분할 다운로드의 Firefox·Safari 확장 — OPFS 파트 + 브라우저 내보내기 (D8)

작성 2026-10-14. 브랜치 `feat/split-export-firefox-safari`. 설계 §5.4의 플랜 A(D7)를 전제로 한다.

## 1. 배경

D7-A 이후 분할 다운로드의 데이터 경로는 두 단계다.

1. **파트 수신**: 파트 워커가 OPFS(`genome-portal-splits/<downloadId>/part-NNNN`)에 `FileSystemSyncAccessHandle`로 제자리 기록 + `flush()`. 진행률 = 파트 파일의 실제 크기. 새로고침·탭 닫기·크래시 뒤에도 청크 단위로 이어받는다.
2. **병합**: 모든 파트가 끝나면 `showSaveFilePicker()`로 고른 목적지 파일에 파트를 순서대로 이어 붙여 `close()` 1회.

Firefox·Safari가 빠졌던 이유는 1단계가 아니라 2단계다. 두 브라우저에도 OPFS와 동기 접근 핸들은 있고(아래 표), 없는 것은 **사용자가 고른 파일에 쓰는 API**(`showSaveFilePicker`, File System Access API)뿐이다. 그래서 2단계를 "목적지 파일에 병합" 대신 **"브라우저의 일반 다운로드로 내보내기"**로 바꾸면 이어받기·병렬·CRC32 검증을 그대로 넓힐 수 있다.

## 2. 브라우저 기능 매트릭스 (MDN browser-compat-data, 2026-10-14 조회)

| 기능                                                | Chrome/Edge | Firefox        | Safari  | 비고                                                                                          |
| --------------------------------------------------- | ----------- | -------------- | ------- | --------------------------------------------------------------------------------------------- |
| `showSaveFilePicker` (File System Access)           | 86+         | 없음           | 없음    | Brave는 Chromium이지만 기본 비활성, iOS는 전 브라우저 없음                                    |
| `navigator.storage.getDirectory()` (OPFS)           | 86+         | 111+           | 15.2+   |                                                                                               |
| `FileSystemSyncAccessHandle` `write/flush/truncate` | 102+        | 111+           | 15.2+   | Safari 15.2~16.3은 메서드가 Promise 반환(비표준). 17+부터 동기                                |
| `ReadableStream` transferable (postMessage 전송)    | 87+         | 103+           | **27+** | 서비스 워커 스트리밍 다운로드의 전제                                                          |
| `navigator.storage.persist()`                       | 55+         | 57+ (프롬프트) | 15.2+   | Firefox는 사용자에게 묻고 허용 전까지 OPFS를 10 GiB로 캡 → 프로브 전에 30초 상한으로 기다린다 |
| Blob URL + `<a download>`                           | 전부        | 전부           | 전부    | 파일 참조 Blob은 메모리에 올리지 않는다                                                       |

결론: **OPFS 파트 수신은 Chrome 102+, Firefox 111+, Safari 17+에서 가능**하고, 내보내기는 두 경로 중 하나가 항상 있다.

- **SW 스트림**(transferable stream 지원): 파트 파일을 순서대로 `ReadableStream`으로 묶어 서비스 워커에 전송하고, 숨은 iframe으로 `/portal-export/<id>`를 내비게이션해 `Content-Disposition: attachment` + **`Content-Length`** 응답을 받는다. 브라우저 다운로드 UI에 총 크기·남은 시간이 보이고, 스트림이 끝나는 시점을 엔진이 알아 **파트 파일을 즉시 삭제**한다. 대상: Chrome(FS Access 없는 변종), Firefox 111+, Safari 27+.
- **Blob 내보내기**(transferable stream 없음): `new Blob([part0File, part1File, ...])` — 각 파트는 OPFS `File` 참조라 복사·메모리 적재가 없다 — 를 `URL.createObjectURL`로 `<a download>` 클릭. 브라우저가 Blob을 다운로드 폴더에 복사한다. 엔진은 완료 시점을 알 수 없어 **파트 파일을 유지**하고, 사용자가 목록에서 제거하거나 24시간이 지나면 삭제한다. 대상: Safari 17~26, iOS Safari.

## 3. 변경 범위

### 3.1 판정 (`planner.ts`, `contract.planClientMode`)

`hasFileSystemAccess: boolean` 대신 `splitCapability(): 'picker' | 'export' | 'none'`.

| 판정     | 조건                                                                                                                                                                                                                         | 저장                             | 전달                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `picker` | `typeof window.showSaveFilePicker === 'function'`                                                                                                                                                                            | OPFS(D7-A), 부족 시 direct(D7-C) | 목적지 파일 병합 (기존)                                               |
| `export` | 위가 없고 `navigator.storage.getDirectory`가 함수이며 `Worker`가 있음(동기 접근 핸들은 워커 안에서만 노출되어 메인 스레드에서 감지하지 않는다 — Firefox 155·Chromium 153 프로브; OPFS가 있는 지원 범위 브라우저는 모두 가짐) | OPFS만                           | SW 스트림 → 없으면 Blob                                               |
| `none`   | 둘 다 없음 (Firefox ≤ 110, Safari ≤ 16, OPFS 비활성)                                                                                                                                                                         | —                                | 기존 폴백: ≤ 50GB 일반 다운로드 + R5.9 안내, > 50GB 명령어 다이얼로그 |

`planClientMode(size, canSplit = capability !== 'none', settings)`: 표는 그대로다(`split` 열의 머리글이 "File System Access 있음"에서 "분할 가능"으로 바뀜). 50GB 초과 파일도 `export`에서 `split`이다 — 파트(≤ 8GiB) 단위 GET이라 CloudFront 단일 객체 한도와 무관하다(53GiB 실측, acceptance §3-6).

### 3.2 레코드 (`store.ts`)

- `fileHandle?: FileSystemFileHandle` — `export`에는 없다. 기존 레코드는 그대로 유효(`delivery` 없음 = `picker`).
- `delivery?: 'picker' | 'export'`.
- `verified?: boolean` — `export`: 파트 전체의 CRC32 검증을 통과했다. 재개 시 수신·검증을 건너뛰고 내보내기만 다시 한다.
- `exportedAt?: number`, `exportMode?: 'stream' | 'blob'` — Blob 경로 완료 시각(파트 보존 기한의 기준).
- 상태 `exporting` 추가. 일시정지 사유 `EXPORT_FAILED` 추가.

### 3.3 엔진 (`splitEngine.ts`)

`execute()`의 `export` 경로:

```
transfer(OPFS, 기존과 동일) → verifyParts(파트를 순서대로 스트리밍, CRC32) → exporting → complete
```

- 검증을 **내보내기 전에** 한다(기존 경로는 병합 후 목적지 파일을 다시 읽는다). 손상이면 브라우저가 100GB를 복사하기 전에 `CHECKSUM_MISMATCH`로 끝난다. 검증 중 파트가 사라져 있으면(`PartMissingError`) 그 파트만 다시 받고 재검증한다.
- 내보내기 결과: `streamed`(SW가 스트림을 끝까지 소비) → 파트 삭제·`complete`; `handed`(Blob을 브라우저에 넘김) → 파트 유지·`complete`·`exportedAt`; 예외/브라우저 측 취소 → `paused(EXPORT_FAILED)`, 재개 = 내보내기만 재시도.
- `start()`에서 저장 선택이 `direct`(OPFS 없음·할당량 부족)이면 `export`는 진행할 수 없다 → `SplitUnavailableError(reason)`를 던지고 **핸들러가 기존 폴백**(일반 다운로드/명령어)으로 내려간다. 사용자에게는 사유를 토스트로 알린다.
- 전송 중 `STORAGE_QUOTA`: `export`에는 direct 이관이 없다. `paused(STORAGE_QUOTA)` → 재개는 OPFS에서 재시도(공간을 비운 뒤). 문구가 다르다.
- `resume()`: `export`는 권한 재요청(`requestReadWrite`)이 없다. `cancel()`/`remove()`: 파트 삭제만(목적지 파일 없음). `load()`: `exporting`으로 남은 레코드는 `paused(INTERRUPTED)`(`verified` 유지); Blob 경로 `complete` 레코드는 `exportedAt + 24h` 뒤 파트와 함께 정리.
- `persist()`는 할당량 프로브 **앞에서 상한 시간(`PERSIST_WAIT_MS` 30초) 안에서만** 기다린다. Firefox는 best-effort 오리진을 10 GiB로 캡하고 보존 허용 뒤에만 한도를 올리므로(§6.1) 순서가 중요하다. 프롬프트가 무시되면 10 GiB 한도에서 프로브가 거부되어 `OPFS_QUOTA` 폴백으로 내려간다. Chromium은 즉시 응답한다.

### 3.4 내보내기 (`exportDelivery.ts`, `public/portal-export/export-sw.js`)

- `concatParts(parts, onProgress)`: 파트 Blob 시퀀스를 하나의 `ReadableStream<Uint8Array>`로. 검증과 SW 스트림이 공유한다.
- 자체 서비스 워커(라이브러리 `download-sw.js`와 같은 프로토콜, `Content-Length` 추가). 스코프 `/portal-export/`, 앱 시작 시 등록. CloudFront SPA 라우팅 함수는 확장자 있는 경로(`export-sw.js`)를 그대로 두고, `/portal-export/<id>` 내비게이션은 네트워크에 가기 전에 SW가 가로채므로 인프라 변경이 없다.
- **iframe 수명 불변식**: 다운로드를 시작한 숨은 iframe은 **브라우저가 응답 스트림을 끝까지 당길 때까지(소스 스트림 close)** DOM에 남아야 한다. 전송 도중 iframe을 제거하면 Firefox가 저장 파일을 그 시점까지로 **절단**한다(초기 구현의 60초 고정 타이머가 106초/12GiB 다운로드를 ≈5.4GB에서 끊었다). 따라서 고정 타이머를 두지 않는다 — 150GB가 몇 시간 걸려도 프레임은 전송 내내 유지하고, close 직후 짧은 마무리 유예(`EXPORT_FINALIZE_GRACE_MS`, 3초)만 두어 브라우저가 파일을 flush하게 한 뒤 제거한다. 완료 시점 신호는 `concatParts`의 `onClose`(브라우저가 마지막 바이트를 당긴 순간)이며, 소비자 취소는 `onCancel`로 구분한다.
- `supportsTransferableStreams()`: `new MessageChannel()`에 스트림을 전송해 보고 `DataCloneError`면 false(Safari ≤ 26).
- Blob 경로의 object URL은 레코드 제거/취소 시 `revokeObjectURL`.

### 3.5 UI·문구

- 행 배지: Firefox·Safari에서 1GiB 초과 파일이 "분할 다운로드"가 된다(명령어 배지는 `none`일 때만).
- 패널: 상태 `exporting`("브라우저 다운로드로 전달 중" + 진행률), `export` 레코드의 디스크 안내(임시 저장 공간 1×만), Blob 경로 완료 항목의 보존 안내("브라우저 다운로드가 끝났으면 제거 — 임시 데이터 N, 24시간 뒤 자동 삭제"), `STORAGE_QUOTA`·`EXPORT_FAILED` 사유 문구.
- 토스트: 검증 통과 후 "브라우저 다운로드로 전달합니다. 다운로드 목록에서 저장 진행을 확인하세요"; `SplitUnavailableError` 폴백 사유.

## 4. 실패 모드와 처리

| 상황                                   | 동작                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 내보내기 중 새로고침                   | `load()` → `paused(INTERRUPTED)`, `verified=true` → 재개는 내보내기만                                                                                      |
| 브라우저 다운로드 UI에서 취소(SW 경로) | 전송 스트림 `cancel`이 소스로 전파 → `paused(EXPORT_FAILED)`, 파트 보존                                                                                    |
| SW 미등록/등록 실패                    | Blob 경로로 즉시 폴백                                                                                                                                      |
| Blob 경로에서 사용자가 저장을 취소     | 엔진은 알 수 없음 → 레코드는 `complete`, 파트는 24시간 보존, 패널의 "다시 내보내기" 버튼으로 재전달                                                        |
| 파트 축출(사이트 데이터 삭제)          | 검증/내보내기 시 `PartMissingError` → 해당 파트 재수신(`reconciled`)                                                                                       |
| OPFS 할당량 부족(시작 시)              | `SplitUnavailableError('OPFS_QUOTA')` → 기존 폴백 + 사유 토스트                                                                                            |
| OPFS 할당량 부족(전송 중)              | `paused(STORAGE_QUOTA)`, 재개 재시도. 안내: 공간 확보 또는 Chrome/Edge                                                                                     |
| Safari 16 이하(비표준 핸들)            | `createSyncAccessHandle`은 있으나 워커의 동기 호출이 Promise를 반환 → 첫 쓰기에서 `fileError` → `paused(FILE_ERROR)`. 지원 범위(최신 3개 버전) 밖이라 수용 |

## 5. 비용·자원

- 로컬 I/O: 수신 1× 쓰기 + 검증 1× 읽기 + 내보내기 1× 읽기 + 브라우저 저장 1× 쓰기 = 4× 선형(기존 경로 3× + 검증 1× = 4×, 동일).
- 디스크: OPFS 1×(시스템 드라이브) + 다운로드 폴더 1×. Blob 경로는 두 사본이 최대 24시간 공존.
- 네트워크·CloudFront: 변화 없음(파트 GET 동일).

## 6. 검증 계획

| 층                             | 내용                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 단위(contract)                 | `planClientMode(size, canSplit)` 표                                                                                                                                                                                                                                                                                                                          |
| 단위(planner)                  | `splitCapability()` 3분기, Brave/iOS 시뮬레이션(`showSaveFilePicker` 삭제)                                                                                                                                                                                                                                                                                   |
| 단위(engine)                   | export 시작(picker 미호출·`fileHandle` 없음) · 전송→검증→스트림 내보내기→파트 삭제 · Blob 내보내기→파트 유지→`remove()` 삭제·24h 정리 · 검증 전 파트 소실→재수신 · 내보내기 실패→`EXPORT_FAILED`→재개는 내보내기만 · `exporting` 중단→`INTERRUPTED`(`verified` 유지) · 시작 시 OPFS 불가→`SplitUnavailableError` · 전송 중 `STORAGE_QUOTA`(이관 없음) · 취소 |
| 단위(handler)                  | `SplitUnavailableError` → 일반 다운로드(≤ 50GB) / 명령어(> 50GB) + 토스트                                                                                                                                                                                                                                                                                    |
| 단위(delivery)                 | `concatParts` 순서·진행률, transferable 감지, Blob 경로 앵커, SW 스크립트의 응답 헤더                                                                                                                                                                                                                                                                        |
| e2e Firefox (dev 백엔드, 2GiB) | 분할 패널 `data-delivery=export` → 5% 일시정지/재개 → +10%p 새로고침 → `INTERRUPTED` 진행률 보존 → 재개 → `verifying` → `exporting` → Playwright `download` 이벤트 → 저장 파일 CRC32 = 시드 값. 12GiB가 아닌 이유는 §6.1                                                                                                                                     |
| e2e Firefox (53GiB, 전송 없음) | 행 배지 "분할 다운로드"; OPFS를 끈 init script에서는 기존 "명령어 다운로드" + 다이얼로그                                                                                                                                                                                                                                                                     |
| e2e Chromium (12GiB)           | `showSaveFilePicker` 제거(Brave 시뮬레이션) + transferable 비활성 플래그 → Blob 경로 → 다운로드 이벤트 → CRC32                                                                                                                                                                                                                                               |

### 6.1 실측 (2026-10-14, dev, 로컬 Vite + dev 백엔드)

| 항목                                    | Firefox 143 (Playwright 1543), 2GiB `sample-2gib.bin`                  |
| --------------------------------------- | ---------------------------------------------------------------------- |
| 경로 / 저장 / 전달                      | S3(첫 다운로드) / `opfs` / `export`, 파트 1개                          |
| 시작 → 5% 일시정지                      | 4.7 s                                                                  |
| 새로고침 지점 → 새로고침 후 진행률      | 23% (513,490,777 B) → **513,490,777 B, 손실 0**, `paused(INTERRUPTED)` |
| 재개 → 전체 수신 / 파트 CRC32 검증      | 19.7 s / 4.4 s                                                         |
| SW 스트림 → 브라우저 저장 완료          | 22.0 s, 저장 크기 2,147,483,648 B(절단 없음)                           |
| 저장 파일 CRC32 (Node zlib, SPA 비신뢰) | `9SRMCg==` = S3 full-object 값                                         |
| 총 벽시계(일시정지 포함) / 파트 삭제    | 58.4 s / 스트림 종료 후 OPFS 디렉터리 삭제 확인                        |

| 항목                            | Chromium 151 (Playwright), 12GiB `sample-12gib.bin`, `showSaveFilePicker` 제거 + Blob 강제 |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| 경로 / 저장 / 전달 / 파트       | CF / `opfs` / `export`(Blob) / 2개(8 GiB + 4 GiB)                                          |
| 전체 수신 / 파트 CRC32 검증     | 100.1 s / 41.5 s                                                                           |
| Blob → 브라우저 저장(복사) 완료 | 91.0 s, 저장 크기 12,884,901,888 B                                                         |
| 저장 파일 CRC32 (Node zlib)     | `/sXQ3A==` = S3 full-object 값                                                             |
| 총 벽시계 / 파트                | 276.9 s / `complete` 뒤 파트 유지(24 h 보존), 패널 "제거"로 삭제 확인                      |

같은 날 **수정 전** 코드의 12GiB 실행은 새로고침·검증까지 통과했으나 SW 스트림 저장이 5,423,267,840 B(≈42%)에서 끊겼다 — §3.4의 60초 고정 타이머 결함. 수정 후 12GiB 재실행은 두 번 모두 끝까지 가지 못했는데 원인은 제품이 아니라 **테스트 하네스**다: Playwright의 Firefox 빌드(Juggler `NetworkObserver`)는 `response.body()`를 위해 진행 중인 모든 응답 본문을 브라우저 부모 프로세스에 복사해 두므로(요청 종료 시 100MB 한도의 저장소로 옮기며 버림), 8GiB 파트 GET 하나가 부모 RSS를 8GB 키운다. 12GiB 실행은 RSS 10.3GB·호스트 iowait 90%·가용 메모리 2GB에서 정지했다(한 번은 호스트 세션 단절, 한 번은 수동 중단). 일반 Firefox에는 이 리스너가 없어 디스크로 스트리밍된다. 그래서 Firefox e2e는 같은 코드 경로를 지나는 최소 분할 객체(2GiB, 단일 파트)로 고정했고, 12GiB 이상의 Firefox 검증은 Playwright 밖(수동 또는 `web/e2e/scripts/probe-firefox-sw-export.mjs`처럼 응답 본문 없이 SW만 쓰는 프로브)에서 한다. 멀티 파트(2개) 흐름은 Chromium Blob 테스트(12GiB)가 덮는다.

Firefox OPFS 할당량 프로브(`probe-firefox-quota.mjs`, 2026-10-14 재실행): best-effort 오리진은 `estimate().quota` = 10 GiB이고 12 GiB+256 MiB `truncate()`는 `NS_ERROR_FILE_NO_DEVICE_SPACE`로 거부된다. `persist()`는 사용자 프롬프트에 걸려 응답 전까지 pending(테스트 prefs로 자동 허용하면 `true`), 허용 뒤에는 quota가 268 GB(여유 디스크 비율)로 올라간다. 그래서 엔진은 **`persist()`를 할당량 프로브보다 먼저, 상한 시간(`PERSIST_WAIT_MS`) 안에서** 호출한다(§3.3): 프롬프트가 무시되면 10 GiB 한도에서 프로브가 실패해 `OPFS_QUOTA` 폴백으로 내려간다. 사용자 안내 문구에 "Firefox의 '사이트 데이터 보존' 허용"을 넣는 이유다. 부수 발견: 예약 중 예외가 나도 핸들을 닫지 않으면 같은 파일의 다음 `createSyncAccessHandle()`이 `NoModificationAllowedError`로 막힌다 — 워커 싱크는 `finally`에서 반드시 닫아야 한다(`splitWorker.ts`는 그렇게 되어 있고, 프로브도 같이 고쳤다).

## 7. 원복

브랜치 `feat/split-export-firefox-safari`에만 커밋한다. dev 배포는 e2e 통과 후 검토를 거쳐서만 하고, 원복은 `main`을 그대로 재배포하면 된다(`web` 스택만 변경, 인프라 변경 없음). IndexedDB 레코드는 기존 필드만으로도 읽히므로(`delivery` 없음 = `picker`) 되돌려도 진행 중 다운로드가 깨지지 않는다 — 단 `export` 레코드는 옛 코드가 `fileHandle` 없이 재개하려다 실패하므로, 원복 전 완료되지 않은 export 다운로드는 취소하는 것이 깔끔하다.

### 7.1 dev 배포 기록 (2026-10-15 00:49–00:51 UTC)

- 배포 대상: 브랜치 HEAD `b457827`의 `web/dist`(`vite build` 직후) → `tools/deploy.sh --env dev --only genome-portal-web`. web 스택 129 s, 번들 `assets/index-C9QxNMP2.js`.
- 부수 효과: `deploy.sh`는 `cdk deploy`에 `--exclusively`를 주지 않아 의존 스택도 함께 평가한다. auth/waf/cdn/data는 "no changes"; **api 스택은 Lambda 2개(`Fn-credentials`, `Fn-admin`) 코드가 갱신**됐다. 원인은 이 브랜치의 `contract/src/index.ts` 변경(`planClientMode` 파라미터 이름·주석만, 동작 동일)이 Lambda 번들 해시를 바꾼 것. 기능 변화는 없으나 "web 스택만 변경"이라는 위 문장은 정확히는 "web + api Lambda 재패키징"이다.
- 배포본 검증: `/portal-export/export-sw.js` 200(text/javascript), 라이브 번들 = 로컬 dist 해시, 번들에 capability 판정(`getDirectory` 검사)·`finalizeGraceMs` 경로 포함(60 초 고정 타이머 제거 확인). **배포 포털을 대상으로 Firefox 2GiB export e2e 재실행 → 통과**(00:52Z, `E2E_BASE_URL=https://<portal>`): 22%(493,830,572 B)에서 새로고침 → 손실 0 → 재개 18.4 s → 파트 CRC32 4.4 s → SW 스트림 저장 23.0 s → 저장 파일 CRC32 `9SRMCg==` = S3 값, 총 57.6 s. 로그 `~/.cache/genome-portal-e2e/logs/export-firefox-20261015T005208Z.log`.
- 미실시: 실제(비-Playwright) Firefox/Safari에서의 12 GiB 이상 수동 확인, 배포 포털 대상 Chromium Blob(12 GiB) 재실행(로컬 Vite에서는 통과, 번들 동일).

### 7.2 원복 명령

```bash
# main 트리의 web 번들을 다시 올린다 (deploy.sh는 빌드하지 않으므로 vite build가 먼저).
git switch main
(cd web && npm run build)
tools/deploy.sh --env dev --only genome-portal-web
# api Lambda도 main의 번들로 되돌아간다(의존 스택 평가에 포함). 코드 동작은 양쪽이 같다.
```

원복 뒤에는 Firefox/Safari에서 1 GiB 초과 파일이 다시 "이어받기 미지원" 안내 + 일반 다운로드(≤50 GB) / 명령 다이얼로그(>50 GB)로 돌아간다. 진행 중이던 `export` 레코드는 패널에서 "제거"로 지우면 OPFS 파트도 함께 삭제된다.
