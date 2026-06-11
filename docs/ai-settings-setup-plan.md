# ai-settings-setup.sh 설계 정리

## 목적
`ai-settings-setup.sh`가 `pi` 전용 설정을 설치할 때, 소스/대상 경로를 명확히 분리하고, `agents`, `chains`, `skills`가 없거나 비어 있으면 설치를 건너뛴다.

## 전제
- `selected_agent_name == pi` 인 경우를 우선 설계한다.
- 다른 agent는 이후 별도 경로 매핑을 추가한다.
- 경로 문자열은 스크립트 상단 변수로 모은다.

## 현재 합의된 경로
### 소스
- `agents`: `.agents/pi/agent/agents/`
- `chains`: `.agents/pi/agent/chains/`
- `skills`: `.agents/skills/`
- root 설정 파일: `.agents/pi/agent/` 아래 파일들

### 대상
- 사용자:
  - `.pi/agent`
- 프로젝트:
  - `.pi`

### 세부 매핑
- `.agents/pi/agent/agents/` → `~/.pi/agent/agents/`, `<project>/.pi/agents/`
- `.agents/pi/agent/chains/` → `~/.pi/agent/chains/`, `<project>/.pi/chains/`
- `.agents/skills/` → `~/.pi/agent/skills/`, `<project>/.pi/skills/`
- `.agents/pi/agent/*.json`, `APPEND_SYSTEM.md` → `~/.pi/agent/`, `<project>/.pi/`

## 스킵 규칙
다음 경우에는 복사를 건너뛴다.
- 폴더가 없음
- 폴더는 있지만 하위 파일/디렉터리가 없음
- 대상이 이미 존재하고 덮어쓸 필요가 없는 경우

## 설계 포인트
- `pi` 전용 경로는 상단 변수로 선언한다.
- `agents`, `chains`, `skills`는 공통 복사 함수로 처리한다.
- 비어 있는 디렉터리는 생성만 하지 않는다.
- `pi` 전용 패키지 설치는 기존 흐름을 유지한다.
- `docs`는 프로젝트 scope일 때만 설치한다.

## 현재 상태
- `ai-settings-setup.sh`는 위 설계를 반영하도록 수정 완료.
- 이후 `pi` 외 agent 경로가 생기면 별도 매핑을 추가한다.
