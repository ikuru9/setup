# ai-settings-setup.sh 설계 정리

`ai-settings-setup.sh`가 `pi`와 `omp` 설정을 설치할 때, 에이전트별 소스/대상 경로를 명확히 분리하고, 비어 있는 디렉터리는 설치를 건너뛴다.

## 전제
- `selected_agent_name == pi`인 경우 Pi 전용 경로와 패키지 설치를 사용한다.
- `selected_agent_name == omp`인 경우 OMP 전용 경로를 사용한다.
- 다른 agent는 일반적인 `.<agent명>` 경로 매핑을 사용한다.
- 경로 문자열은 스크립트 상단 변수로 모은다.

## 현재 합의된 경로
### 소스
- Pi 설정 파일: `agents/pi/` 아래 파일들
- OMP 설정 파일: `agents/omp/` 아래 파일들

### 대상
- Pi:
  - 사용자: `.pi/agent`
  - 프로젝트: `.pi`
- OMP:
  - 사용자: `.omp/agent`
  - 프로젝트: `.omp`

## 세부 매핑
- `agents/pi/agent/*` → `~/.pi/agent/`, `<project>/.pi/`
- `agents/omp/*` → `~/.omp/agent/`, `<project>/.omp/`

## 스킵 규칙
다음 경우에는 복사를 건너뛴다.
- 폴더가 없음
- 폴더는 있지만 하위 파일/디렉터리가 없음
- 대상이 이미 존재하고 덮어쓸 필요가 없는 경우

## 설계 포인트
- Pi와 OMP 전용 경로는 상단 변수로 선언한다.
- `agents`, `chains`, `skills`는 공통 복사 함수로 처리한다.
- 비어 있는 디렉터리는 생성만 하지 않는다.
- Pi 전용 패키지 설치는 선택된 agent가 `pi`일 때만 수행한다.
- `docs`는 프로젝트 scope일 때만 설치한다.

## 현재 상태
- `ai-settings-setup.sh`는 Pi와 OMP의 사용자/프로젝트 경로 매핑을 반영한다.
- OMP 사용자 설정은 OMP 런타임의 `~/.omp/agent` 경로를 사용한다.
