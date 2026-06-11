# Pi Subagents + Matt Pocock Skills 사용 가이드

## 1. 기본 방향

이 프로젝트에서는 **Matt Pocock skills를 작업 원칙**으로 사용하고, **Pi subagents를 역할별 실행 도구**로 사용한다.

```text
Matt Pocock skills = 작업 방식 / 프로세스 / 문서화 규칙
Pi subagents       = 역할별 실행 / 구현 / 리뷰 / 체인 실행
```

큰 기능은 바로 구현하지 않고, 계획 → PRD → issue 분해 → 구현 → 리뷰 순서로 진행한다.
버그는 구현 agent가 아니라 `bugfixer`로 시작한다.

외부 라이브러리, 공식 문서, 최신 API 동작, 버전별 차이가 필요한 작업은 `researcher`를 먼저 사용한다.

---

## 2. 사용 Subagent 목록

| Subagent        | 목적                                                                           | 사용 Skill                           |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `researcher`    | 외부 공식 문서, 라이브러리 문서, 최신 API 변경, 버전별 차이를 조사             | builtin researcher / web access      |
| `planner`       | 요구사항을 `CONTEXT.md`, ADR, 프로젝트 용어 기준으로 정렬하고 구현 방향을 계획 | `grill-with-docs`                    |
| `prd-writer`    | 정리된 요구사항이나 계획을 PRD로 변환                                          | `to-prd`                             |
| `issue-breaker` | PRD/spec/plan을 vertical slice issue로 분해                                    | `to-issues`                          |
| `worker`        | 승인된 issue 또는 plan을 TDD 방식으로 구현                                     | `tdd`                                |
| `bugfixer`      | 버그, 회귀, 실패 테스트, 성능 문제를 재현 후 수정                              | `diagnose`                           |
| `reviewer`      | 구현 결과를 correctness, test quality, scope, architecture 기준으로 리뷰       | 없음. 프로젝트 review 규칙 직접 사용 |
| `handoff`       | 다음 session 또는 agent가 이어받을 수 있도록 현재 상태 정리                    | `handoff`                            |

현재 workflow에서는 다음 builtin subagent를 사용하지 않는다.

| Subagent          | 처리     | 이유                                                               |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `scout`           | disabled | `planner`, `researcher`, 또는 필요한 경우 `zoom-out` 흐름으로 충분 |
| `oracle`          | disabled | `grill-with-docs` 기반 `planner`와 역할 중복                       |
| `context-builder` | disabled | `CONTEXT.md`, ADR, PRD, issue, handoff와 context source가 중복됨   |

---

## 3. Matt Skill 사용 기준

| Skill                      | 목적                                                                             | 주 사용 Agent   |
| -------------------------- | -------------------------------------------------------------------------------- | --------------- |
| `setup-matt-pocock-skills` | 프로젝트의 문서 위치, issue 방식, triage 기준, Matt skills 사용 기준을 초기 정렬 | 직접 실행       |
| `grill-with-docs`          | 요구사항을 `CONTEXT.md`, ADR, 프로젝트 용어 기준으로 압박/정렬                   | `planner`       |
| `to-prd`                   | 정리된 요구사항을 PRD로 변환                                                     | `prd-writer`    |
| `to-issues`                | PRD/spec/plan을 vertical slice issue로 분해                                      | `issue-breaker` |
| `tdd`                      | 승인된 기능/리팩터링을 테스트 주도 방식으로 구현                                 | `worker`        |
| `diagnose`                 | 버그를 재현, 가설화, 계측, 수정, 회귀 테스트까지 진행                            | `bugfixer`      |
| `handoff`                  | 다음 session/agent가 이어받을 수 있도록 작업 상태를 압축                         | `handoff`       |

### `setup-matt-pocock-skills`

`setup-matt-pocock-skills`는 일반 작업용 subagent가 아니라 **프로젝트 초기 기준을 정렬하는 setup skill**이다.

사용 목적:

```text
CONTEXT.md 위치 확정
ADR 위치 확정
PRD 저장 방식 확정
issue tracker 방식 확정
triage label vocabulary 확정
Matt skills가 참조할 프로젝트 운영 기준 정리
```

사용 시점:

```text
프로젝트 최초 1회
문서 구조를 크게 바꾼 경우
issue tracker 방식을 바꾼 경우
Matt skills가 CONTEXT.md / ADR / issue 위치를 제대로 못 찾는 경우
```

사용 예시:

```bash
/setup-matt-pocock-skills
```

운영 원칙:

```text
setup-matt-pocock-skills는 기능 구현 전에 프로젝트 기준을 맞추는 용도다.
일반 기능 개발, 버그 수정, 리뷰마다 반복 실행하지 않는다.
setup 결과는 planner, prd-writer, issue-breaker, worker, bugfixer, handoff가 공통 기준으로 참조한다.
```

---

## 4. Agent별 사용 기준

| 상황                                                | 사용할 Agent               |
| --------------------------------------------------- | -------------------------- |
| Matt skills가 참조할 프로젝트 기준을 처음 잡아야 함 | `setup-matt-pocock-skills` |
| 외부 공식 문서나 최신 API 확인이 필요함             | `researcher`               |
| 라이브러리 버전별 동작 차이를 확인해야 함           | `researcher`               |
| 요구사항이 애매함                                   | `planner`                  |
| 기존 도메인 용어/ADR과 맞춰야 함                    | `planner`                  |
| PRD가 필요함                                        | `prd-writer`               |
| PRD나 계획을 구현 issue로 쪼개야 함                 | `issue-breaker`            |
| 승인된 기능이나 issue를 구현해야 함                 | `worker`                   |
| 버그를 재현하고 고쳐야 함                           | `bugfixer`                 |
| 구현 결과를 검토해야 함                             | `reviewer`                 |
| 다음 세션으로 작업을 넘겨야 함                      | `handoff`                  |

---

## 5. 기본 Workflow

### 프로젝트 최초 기준 정렬

```text
setup-matt-pocock-skills
```

예시:

```bash
/setup-matt-pocock-skills
```

이 단계는 일반 기능 개발 workflow가 아니라, Matt skills가 프로젝트 문서와 issue 기준을 일관되게 참조하도록 만드는 초기 정렬 단계다.

---

### 외부 문서 확인이 필요한 작업

```text
researcher → planner → worker → reviewer
```

예시:

```bash
/run researcher "현재 사용하는 라이브러리의 공식 문서 기준으로 OAuth callback 처리 권장 방식을 조사해줘."
/run planner "researcher 결과를 바탕으로 현재 프로젝트의 인증 흐름 개선 계획을 세워줘. 구현하지 마."
/run worker "승인된 plan만 구현해줘."
/run reviewer "현재 diff를 공식 문서 근거, behavior correctness, test quality 기준으로 리뷰해줘."
```

원칙:

```text
최신 API, 버전별 차이, 외부 라이브러리 동작은 추측하지 않는다.
먼저 researcher로 공식 문서 기준을 확인한다.
```

---

### 작은 기능 / 명확한 변경

```text
planner → worker → reviewer
```

예시:

```bash
/run-chain plan -- 잘못된 이메일 입력 시 표시할 검증 메시지 추가
/run-chain implement -- 승인된 검증 메시지 계획을 구현
/run-chain review -- 현재 변경 사항(diff) 검토
```

---

### 큰 기능

```text
planner → prd-writer → issue-breaker → worker → reviewer → handoff
```

외부 문서가 필요한 큰 기능은 앞에 `researcher`를 붙인다.

```text
researcher → planner → prd-writer → issue-breaker → worker → reviewer → handoff
```

예시:

```bash
/run researcher "팀 초대 플로우에서 사용하는 이메일 초대/토큰 만료 관련 보안 권장사항을 공식 문서 중심으로 조사해줘."
/run-chain feature -- 팀 초대 기능 추가
/run-chain implement -- 승인된 issue #1만 구현
/run-chain review -- 현재 diff 리뷰
/run-chain handoff -- 현재 팀 초대 작업 상태 정리
```

원칙:

```text
feature.chain은 계획, PRD, issue 분해까지만 한다.
구현은 issue 단위로 따로 실행한다.
```

---

### 버그 수정

```text
bugfixer → reviewer → handoff
```

외부 라이브러리나 framework 동작이 원인일 수 있으면 앞에 `researcher`를 붙인다.

```text
researcher → bugfixer → reviewer → handoff
```

예시:

```bash
/run researcher "현재 framework 버전의 redirect/cookie 처리 관련 알려진 변경사항을 공식 문서 기준으로 확인해줘."
/run bugfixer "로그인 redirect 회귀 버그를 재현하고 root cause를 분석한 뒤 수정해줘."
/run reviewer "현재 버그 수정 diff를 correctness, regression risk, test coverage 기준으로 리뷰해줘."
/run handoff "로그인 redirect 버그 수정 작업의 현재 상태와 후속 작업을 정리해줘."
```

원칙:

```text
재현 없이 수정하지 않는다.
feedback loop 없이 production code를 바꾸지 않는다.
외부 라이브러리 동작은 researcher로 확인한다.
```

---

### 리팩터링

```text
planner → worker → reviewer
```

외부 framework migration이나 API 변경이 관련되면:

```text
researcher → planner → worker → reviewer
```

예시:

```bash
/run researcher "현재 framework 버전에서 권장하는 auth middleware 구조를 공식 문서 기준으로 조사해줘."
/run planner "billing module refactor 계획을 CONTEXT.md와 ADR 기준으로 정리해줘. 구현하지 마."
/run worker "승인된 refactor slice #1만 구현해줘. public behavior는 유지해."
/run reviewer "현재 refactor diff를 behavior preservation, test quality, scope 기준으로 리뷰해줘."
```

---

### 세션 인계

```text
handoff
```

예시:

```bash
/run-chain handoff -- 다음 세션을 위해 현재 작업 상태를 요약해줘
```

---

## 6. Chain 사용법

| Chain       | 목적                           | 흐름                                   |
| ----------- | ------------------------------ | -------------------------------------- |
| `plan`      | 구현 전 계획만 생성            | `planner`                              |
| `feature`   | 큰 기능을 PRD와 issue로 정리   | `planner → prd-writer → issue-breaker` |
| `implement` | 승인된 issue/plan 구현 후 리뷰 | `worker → reviewer`                    |
| `bugfix`    | 버그 재현, 수정, 리뷰          | `bugfixer → reviewer`                  |
| `review`    | 현재 diff 다각도 리뷰          | `reviewer` 다중 관점                   |
| `handoff`   | 다음 세션용 인계 문서 생성     | `handoff`                              |

`researcher`는 독립 agent로 사용한다. chain에 항상 넣지 않고, 외부 근거가 필요한 작업에서 앞단에 명시적으로 실행한다.

`setup-matt-pocock-skills`는 chain이 아니라 프로젝트 기준 정렬용 setup skill로 사용한다.

사용 예시:

```bash
/setup-matt-pocock-skills
/run researcher "공식 문서 기준으로 <topic>을 조사해줘."
/run-chain plan -- <task>
/run-chain feature -- <feature request>
/run-chain implement -- <approved issue or plan>
/run-chain bugfix -- <bug description>
/run-chain review -- 현재 diff를 리뷰해줘.
/run-chain handoff -- 현재 작업 상태를 다음 세션용으로 정리해줘.
```

---

## 7. 자주 쓰는 명령

### 프로젝트 기준 정렬

```bash
/setup-matt-pocock-skills
```

### 외부 문서 조사

```bash
/run researcher "공식 문서 기준으로 이 라이브러리의 최신 권장 사용법과 주의사항을 조사해줘."
```

### 계획

```bash
/run planner "이 작업을 CONTEXT.md와 ADR 기준으로 정렬하고 구현 계획만 만들어줘. 구현하지 마."
```

### PRD 작성

```bash
/run prd-writer "이 계획을 PRD로 정리해줘. 구현 세부사항은 과도하게 고정하지 마."
```

### Issue 분해

```bash
/run issue-breaker "이 PRD를 vertical tracer-bullet issue로 나눠줘. 각 issue에 acceptance criteria와 test expectations를 포함해."
```

### 구현

```bash
/run worker "승인된 issue #N만 구현해줘. scope 확장하지 말고 TDD 원칙을 따라."
```

### 버그 수정

```bash
/run bugfixer "이 버그를 먼저 재현하고, feedback loop를 만든 다음 root cause를 수정해줘."
```

### 리뷰

```bash
/run reviewer "현재 diff를 acceptance criteria, behavior correctness, test quality, scope expansion 기준으로 리뷰해줘."
```

### 병렬 리뷰

```bash
/parallel reviewer "Check correctness" -> reviewer "Check test quality" -> reviewer "Check architecture drift and scope expansion"
```

### 인계

```bash
/run handoff "현재 작업 상태를 다음 세션용으로 정리해줘. 기존 PRD/ADR/issue는 경로로 참조해."
```

---

## 8. 금지 패턴

### setup skill을 일반 작업마다 반복 실행하지 않는다

나쁜 예:

```bash
/setup-matt-pocock-skills
/run worker "작은 UI 문구 수정해줘."
```

좋은 예:

```bash
/run planner "작은 UI 문구 수정 계획만 정리해줘."
/run worker "승인된 수정만 구현해줘."
```

---

### 외부 라이브러리 동작을 추측하지 않는다

나쁜 예:

```bash
/run worker "Next.js 최신 redirect 동작은 아마 이럴 테니 바로 고쳐줘."
```

좋은 예:

```bash
/run researcher "현재 Next.js 공식 문서 기준 redirect 동작과 breaking change를 확인해줘."
/run planner "researcher 결과를 기준으로 수정 계획을 세워줘."
```

---

### 큰 기능을 바로 구현하지 않는다

나쁜 예:

```bash
/run worker "팀 초대 기능 전체 구현해줘."
```

좋은 예:

```bash
/run-chain feature -- 팀 초대 기능 추가
/run-chain implement -- 이슈 #1만 구현
```

---

### 버그를 `worker`로 고치지 않는다

나쁜 예:

```bash
/run worker "로그인 redirect 버그 고쳐줘."
```

좋은 예:

```bash
/run bugfixer "로그인 redirect 버그를 재현하고 고쳐줘."
```

---

### `worker`에게 PRD/issue까지 맡기지 않는다

나쁜 예:

```bash
/run worker "PRD 만들고 issue로 나눈 다음 구현까지 해줘."
```

좋은 예:

```bash
/run prd-writer "기능 계획을 PRD로 정리해줘."
/run issue-breaker "PRD를 vertical issue로 나눠줘."
/run worker "issue #1만 구현해줘."
```

---

### 리뷰 없이 끝내지 않는다

나쁜 예:

```bash
/run worker "구현하고 끝내."
```

좋은 예:

```bash
/run-chain implement -- 승인된 issue #1만 구현
/run-chain review -- 현재 diff 리뷰
```

---

## 9. Source of Truth

작업 중 참조해야 할 문서의 역할은 다음과 같다.

| 문서            | 역할                                               |
| --------------- | -------------------------------------------------- |
| `CONTEXT.md`    | 프로젝트 도메인 용어와 공통 언어                   |
| `docs/adr/`     | 아키텍처 결정 기록                                 |
| PRD             | 기능 요구사항                                      |
| Issues          | 구현 단위                                          |
| Handoff         | 다음 session/agent 인계 문서                       |
| Research notes  | 외부 공식 문서, API, 버전별 차이에 대한 근거 자료  |
| Matt setup 결과 | skills가 참조할 문서 위치, issue 방식, triage 기준 |

context를 여러 종류의 임시 artifact로 분산시키지 않는다.
외부 근거가 필요한 경우에는 researcher 결과를 PRD, plan, issue, handoff에서 참조한다.
Matt setup 결과는 프로젝트 운영 기준으로 취급한다.

---

## 10. 운영 원칙 요약

```text
1. 프로젝트 최초 또는 문서/issue 운영 기준이 바뀌면 setup-matt-pocock-skills로 기준을 정렬한다.
2. 외부 공식 문서, 최신 API, 버전별 차이가 필요한 작업은 researcher부터 시작한다.
3. 큰 기능은 planner부터 시작한다.
4. PRD와 issue는 구현 전에 만든다.
5. 구현은 worker가 issue 단위로 한다.
6. 버그는 bugfixer가 diagnose 방식으로 처리한다.
7. 모든 구현 후 reviewer를 거친다.
8. 다음 세션으로 넘길 때는 handoff를 만든다.
9. scout, oracle, context-builder는 기본 workflow에서 사용하지 않는다.
10. worker에게 research, planning, PRD, issue, handoff 역할을 섞지 않는다.
```
