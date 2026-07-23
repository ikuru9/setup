# claude-pi-convert

`claude-pi-convert`는 Claude Code 플러그인을 Pi coding-agent 패키지로 정적으로 변환합니다. 변환 과정에서는 원본 플러그인 코드를 실행하지 않습니다. 로컬 디렉터리 변환은 네트워크에 접속하지 않으며, GitHub 저장소를 입력한 경우에만 원본을 내려받기 위해 네트워크를 사용합니다.

생성된 패키지는 Pi 패키지가 직접 제공할 수 없는 리소스를 위해 프로젝트 또는 사용자 전역 활성화 방식을 사용합니다.

- 네이티브 skill은 프로젝트 `.pi/skills/` 또는 사용자 `~/.pi/agent/skills/`에 설치됩니다.
- 커스텀 agent는 프로젝트 `.pi/agents/` 또는 사용자 `~/.pi/agent/agents/`에 설치되며 [`@tintinweb/pi-subagents@0.14.2`](https://github.com/tintinweb/pi-subagents)로 실행됩니다.
- MCP 서버는 `.pi/mcp.json`에 병합되며 [`pi-mcp-adapter@2.11.0`](https://github.com/nicobailon/pi-mcp-adapter)로 실행됩니다.
- Claude의 `WebSearch` 및 `WebFetch` 정책에는 [`pi-web-access@0.13.0`](https://github.com/nicobailon/pi-web-access)을 사용합니다.

## 요구 사항

- Node.js 22.19 이상
- Pi coding agent 0.81.1

## 빌드 및 실행

```sh
npm install
npm run build
./dist/claude-pi-convert.mjs --help
```

번들 파일 `dist/claude-pi-convert.mjs`에는 파서 의존성이 포함되어 있습니다. 따라서 `tsx`나 TypeScript 컴파일러 없이 파일을 복사해 실행할 수 있습니다.

## 변환

```sh
claude-pi-convert ./my-claude-plugin -o ./my-pi-plugin

# 위 명령과 동일한 명시적 형식
claude-pi-convert convert ./my-claude-plugin --out ./my-pi-plugin
```

GitHub 저장소는 `owner/repository` 형식 또는 HTTPS URL로 바로 지정할 수 있습니다. `--out`을 생략하면 현재 디렉터리 아래 `extensions/<repository>`에 결과를 만듭니다.

```sh
# ./extensions/agent-skills 생성
claude-pi-convert addyosmani/agent-skills

# 위 명령과 동일
claude-pi-convert https://github.com/addyosmani/agent-skills
```

GitHub 입력은 `git clone --depth 1`으로 임시 위치에만 내려받고, 변환 후 임시 clone을 제거합니다. clone한 플러그인 코드는 실행하지 않습니다.

생성되는 Pi slash command는 기본적으로 플러그인 slug 접두어를 붙이지 않습니다. 다른 플러그인과 command 이름 충돌을 피하려면 `--command-prefix`를 사용합니다.

```sh
claude-pi-convert addyosmani/agent-skills --command-prefix
# 예: build 대신 agent-skills.build 생성
```

변환 결과로 Pi 패키지, 버전이 기록된 JSON/Markdown 보고서, activation manifest 및 생성 파일의 해시·권한을 담은 비공개 소유권 receipt가 생성됩니다. 호환성 결과는 다음과 같이 분류됩니다.

- `converted`: Pi에 직접 대응됩니다.
- `approximated`: 사용할 수 있으나 동작 의미가 일부 다릅니다.
- `preserved`: 실행하지 않는 원본 asset으로 보존됩니다.
- `unsupported`: 안전한 Pi 대응 기능이 없습니다.

`ConversionReport`에는 source/output 식별값, 구성요소별 매핑, 정확한 런타임 요구 사항, 경고, 지원하지 않는 필드, 예정된 활성화 작업이 기록됩니다. `ActivationReceipt`에는 이전 파일 바이트와 권한, 쓰기 후 SHA-256 값, MCP/settings 병합 항목, 명시적 활성화 요청으로 설치한 런타임이 기록됩니다.

`--strict`를 사용하면 결과 중 하나라도 정확한 변환이 아닐 때 종료 코드 2를 반환합니다. 구조화된 데이터, 생성된 프롬프트, UTF-8 텍스트 asset의 리터럴 자격 증명은 기본적으로 환경 변수 placeholder로 교체됩니다. `--include-secrets`를 지정해야만 이를 보존합니다. VCS 메타데이터와 설치된 의존성 트리(`.git`, `.hg`, `.svn`, `node_modules`)는 복사하지 않습니다.

Claude `userConfig`는 `config/user-config.schema.json`과 예제로 변환됩니다. `${user_config.api_token}` 참조에는 Claude의 `CLAUDE_PLUGIN_OPTION_API_TOKEN` 환경 변수 규칙을 적용합니다. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, skill 디렉터리 참조는 변환하거나 런타임에 확장합니다.

Claude manifest의 `dependencies`는 npm 패키지가 아니라 다른 Claude 플러그인에 대한 의존성입니다. 이 값은 `claudePiConvert.pluginDependencies`에 보존되며 자동 Pi 해석 불가 항목으로 보고됩니다. 원본 루트 `package.json`에서 발견한 프로덕션 의존성은 생성된 패키지에 목록으로 기록되며, 활성화 전에 해당 위치에 설치되어 있어야 합니다. 활성화 도구는 안전한 `npm install --ignore-scripts` 명령만 안내하며 임의의 플러그인 의존성을 직접 설치하지 않습니다.

## 활성화

변환 package는 원본 output 디렉터리를 링크하거나 `settings.json`의 local package로 등록하지 않습니다. Pi가 자동 발견하는 extensions 디렉터리에 **완전히 복사**합니다. 따라서 `extensions/agent-skills`를 이동하거나 삭제해도 설치된 확장 프로그램은 계속 동작합니다.

### 프로젝트 설치

```sh
claude-pi-convert activate ./my-pi-plugin \
  --project ./target-project \
  --install-runtimes
```

```text
./target-project/.pi/extensions/<plugin>/
  index.ts                 # Pi 자동 발견 entrypoint
  package/                 # 변환 package의 복사본
```

### 사용자 전역 설치

모든 프로젝트에서 사용할 설치에는 `--user`를 사용합니다.

```bash
claude-pi-convert activate ./my-pi-plugin --user --install-runtimes
```

```text
~/.pi/agent/extensions/<plugin>/
  index.ts                 # Pi 자동 발견 entrypoint
  package/                 # 변환 package의 복사본
```

전역 설치 시 agent와 skill은 각각 `~/.pi/agent/agents/`, `~/.pi/agent/skills/`에 복사됩니다. 프로젝트 정의가 같은 이름을 사용하면 Pi의 일반적인 우선순위에 따라 프로젝트 정의가 전역 정의를 덮어씁니다.

MCP 서버가 포함된 변환물은 사용자 전역 MCP 설정을 임의로 생성하지 않기 위해 현재 `--user` 설치를 지원하지 않습니다. 이 경우 `--project` 설치를 사용합니다.

### settings.json과 런타임

복사된 extension 자체는 `settings.json`에 등록할 필요가 없습니다. Pi가 extensions 디렉터리를 자동으로 탐색해 로드합니다.

다만 `--install-runtimes`로 설치하는 `pi-subagents`, `pi-mcp-adapter`, `pi-web-access` 같은 외부 런타임은 Pi가 해당 scope의 settings에 관리합니다. 이는 변환 package 원본 경로를 등록하는 것이 아니라 npm runtime package 설치 정보입니다.

필수 런타임이 없으면 활성화는 파일을 변경하기 전에 중단하고 정확한 설치 명령을 출력합니다. 갱신 설치는 기존 복사본을 교체하므로 `--force`를 명시합니다.

```sh
claude-pi-convert activate ./my-pi-plugin --project ./target-project --install-runtimes --force
claude-pi-convert activate ./my-pi-plugin --user --install-runtimes --force
```

프로젝트 활성화는 receipt 기반으로 `.pi/mcp.json`을 안전하게 병합하고, agent·skill과 runtime/data/bin asset을 설치합니다. 쓰기 전에 Node/Pi 버전, 런타임 패키지의 정확한 이름·버전·필터, 변환 패키지 의존성, 실행 명령, 충돌, 파일 소유권을 검증합니다. 기존 `.pi/mcp.json` 및 `.pi/settings.json`의 제한적 권한은 보존하며, 새 자격 증명 포함 설정은 소유자만 읽을 수 있도록 만듭니다.

`--dry-run`으로 변경 사항을 미리 확인할 수 있으며, 활성화 상태는 다음 명령으로 점검합니다.

```sh
claude-pi-convert doctor ./my-pi-plugin --project ./target-project
```

## 비활성화

```sh
claude-pi-convert deactivate ./my-pi-plugin --project ./target-project
```

비활성화는 activation receipt의 checksum과 일치하는 converter 소유 데이터만 제거합니다. 사용자가 수정한 파일은 `--force`를 명시하지 않는 한 그대로 둡니다.

현재 `deactivate`와 `doctor`는 프로젝트 설치(`--project`)에 제공됩니다. 사용자 전역 설치는 전역 extensions/agents/skills 경로에서 관리합니다.

## 주요 매핑

| Claude Code | Pi |
| --- | --- |
| `Read`, `Bash`, `Edit`, `Write`, `Grep`, `Glob` | `read`, `bash`, `edit`, `write`, `grep`, `find` |
| `WebSearch` | `web_search` |
| `WebFetch` | `fetch_content` |
| skills | Pi skill |
| commands | namespace가 적용된 Pi slash command |
| agents | `pi-subagents` 프로젝트 agent |
| MCP servers | namespace가 적용된 `pi-mcp-adapter` 서버 |
| lifecycle/tool hooks | 생성된 Pi extension handler |
| LSP definitions | 생성된 stdio LSP tool |
| output styles | namespace가 적용된 세션 프롬프트 modifier |
| themes | 정규화된 네이티브 Pi theme |
| monitors | 세션 범위의 process/file watcher |
| manifest/conventional bin | 활성화된 runtime bin shim 및 PATH 범위 설정 |

MCP 서버명과 평탄화된 agent명에는 플러그인 slug 접두사가 붙어 플러그인 간 충돌을 방지합니다. 원본 참조도 일관되게 다시 작성합니다.

## 보안 모델

변환은 정적 작업이며 source root 이탈, 안전하지 않은 symlink, 경로 순회, 이식 불가능한 파일명, 대소문자를 구분하지 않는 이름 충돌을 거부합니다. 원본 코드를 실행하거나 의존성을 설치하지 않습니다. 로컬 디렉터리 입력은 네트워크에 접속하지 않으며, GitHub 입력은 제한된 HTTPS clone에만 네트워크를 사용합니다. 원본 hook, MCP 서버, LSP 서버, monitor, binary는 사용자가 생성된 Pi 패키지를 활성화하고 실행한 뒤에만 동작하며, 원본 플러그인과 동일한 신뢰 수준으로 취급됩니다.

`--force`의 범위는 의도적으로 제한됩니다. 변환은 이전에 생성한 모든 경로, SHA-256, 권한, output 식별값, 플러그인 식별값이 소유권 receipt와 일치해야만 허용합니다. 활성화는 별도의 receipt와 MCP/settings 3-way 복구를 사용합니다. 일반적인 덮어쓰기 옵션이 아닙니다.

## 알려진 호환성 한계

- Pi package manifest는 agent나 패키지 로컬 MCP 설정을 노출하지 않으므로 활성화가 필요합니다.
- `pi-mcp-adapter`는 MCP hook handler를 위한 공개 프로그래밍 API를 제공하지 않습니다. 따라서 해당 handler는 비공개 import로 재구현하지 않고 지원하지 않는 기능으로 보고합니다.
- Claude teammate/channel, elicitation, worktree lifecycle hook 의미를 완전히 대응하는 공개 Pi 기능은 없습니다.
- Pi subagent의 turn limit, memory 권한, worktree 동작, 모델 우선순위는 일부 다르며 근사 변환으로 보고합니다.
- 웹 접근 설정과 자격 증명은 사용자가 관리합니다. 생성된 패키지에는 기본적으로 이를 포함하지 않습니다.
- Claude 동적 shell context 문법은 실행하지 않는 Markdown으로 보존되고 지원하지 않는 기능으로 보고됩니다. 변환기는 이를 평가하지 않습니다.
- output style은 Pi system prompt에 추가됩니다. Pi의 내장 coding instruction은 제거할 수 없으므로 대체형 style 의미는 근사 변환으로 보고합니다.
- 호환성을 위해 raw shell command는 보존하지만, 실행하지 않고 안전하게 해석할 수 없는 복합 shell 문법은 executable preflight에서 경고만 표시할 수 있습니다.

## 개발

```sh
npm run typecheck
npm test
npm run build
```

고정된 세 Pi 런타임은 Pi 0.81.1 통합 smoke test에 사용하는 정확한 버전의 개발 의존성입니다. 이들은 `dist/claude-pi-convert.mjs`에 import되거나 번들되지 않으며, 변환된 프로젝트는 앞서 설명한 명시적 활성화 흐름을 통해서만 설치합니다.

이 프로젝트는 MIT 라이선스로 배포됩니다. 세 선택형 Pi 런타임은 각각의 라이선스를 따르는 외부 패키지입니다.
