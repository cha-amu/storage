# Storage 업로드 가이드

이 저장소에 직접 파일을 올리면 GitHub Actions가 manifest를 다시 만들고, 메인 사이트의 `/archive/` 자료 목록에 반영한다.

## 경로

```txt
posts/YYYY/글파일.md
assets/images/YYYY/자료파일.확장자
assets/files/YYYY/자료파일.확장자
```

- 글은 `posts/YYYY/`에 Markdown으로 둔다.
- 이미지는 `assets/images/YYYY/`에 둔다.
- PDF, ZIP, TXT, CSV, MP3, MP4 같은 일반 파일은 `assets/files/YYYY/`에 둔다.
- `manifests/`와 `manifest.json`은 자동 생성물이므로 직접 수정하지 않는다.

## 자료 파일명

자료 파일명은 아래 형식을 권장한다.

```txt
검색이름--태그1+태그2+태그3--짧은설명.확장자
```

예시:

```txt
assets/images/2026/고양이포즈--동물+레퍼런스--측면자세.webp
assets/files/2026/설정자료--pdf+설정집--캐릭터 문서.pdf
```

- `검색이름`은 자료 카드 제목이 된다.
- `태그1+태그2`는 자료 태그가 된다.
- `짧은설명`은 자료 설명이 된다.
- 필드 구분자는 `--`, 태그 구분자는 `+`를 쓴다.
- 파일명 안의 `_`는 표시할 때 공백처럼 처리한다.
- URL, 긴 설명, 여러 줄 메모는 파일명에 넣지 말고 사이드카 `.md`에 넣는다.

생략도 가능하다.

```txt
검색이름--태그1+태그2.확장자
검색이름----짧은설명.확장자
--태그1+태그2--짧은설명.확장자
검색이름.확장자
```

모두 생략한 `.확장자` 파일명은 숨김 파일처럼 보일 수 있으므로 쓰지 않는다. 최소한 `untitled.png`처럼 이름을 둔다.

## 긴 설명 사이드카

자료 파일과 같은 경로에 같은 파일명의 `.md`를 두면, 그 파일은 별도 자료로 노출되지 않고 해당 자료의 메타데이터로 사용된다.

```txt
assets/images/2026/고양이포즈--동물+레퍼런스--측면자세.webp
assets/images/2026/고양이포즈--동물+레퍼런스--측면자세.md
```

사이드카 예시:

```md
---
title: 고양이 포즈 참고
tags: [동물, 레퍼런스, 포즈]
sourceUrl: https://example.com/original-page
status: visible
sortOrder: 20
---

측면 자세 참고용 이미지.

- 여러 줄 설명 가능
- [관련 링크](https://example.com)
- 같은 폴더 파일 링크도 가능: [원본](./source.pdf)
```

사이드카가 있으면 아래 값은 파일명보다 우선한다.

```txt
title       자료 제목
tags        자료 태그. [태그1, 태그2] 형식
description 짧은 설명. 없으면 본문 전체를 설명으로 사용
sourceUrl   원본/출처 URL
status      visible, hidden, deleted
sortOrder   낮을수록 먼저 표시
```

본문은 Markdown으로 표시된다. 상대 링크는 storage repo의 같은 경로 기준으로 해석된다.

## 지원 확장자

```txt
이미지: avif, gif, jpg, jpeg, png, svg, webp
파일: pdf, zip, txt, md, json, csv, mp3, mp4, webm
```

같은 이름의 실제 자료가 있으면 `.md`는 사이드카로 처리된다. 같은 이름의 실제 자료가 없으면 `.md`도 일반 파일 자료로 등록된다.

## Google Sheets 동기화

동기화는 이 storage repo의 GitHub Actions에서 돈다. 메인 사이트 repo가 아니라 `cha-amu/storage` 쪽 Actions를 보면 된다.

### 자동으로 도는 경우

```txt
파일 push 직후:
  posts/**, assets/**, sync 스크립트, package.json, sync workflow가 바뀌면 실행

주기 sync:
  매시간 17분에 실행
```

파일을 GitHub 웹에서 직접 올리거나 로컬에서 push하면 `push` 이벤트라서 storage 파일을 최신 원본으로 보고 Sheets에 반영한다. 이때 storage에만 있는 글은 Sheets에 본문까지 복사되고, storage에만 있는 자료는 Sheets의 asset override에 기본 표시 정보가 들어간다.

주기 sync나 수동 실행은 storage와 Sheets 중 `updatedAt`이 더 최신인 쪽을 기준으로 맞춘다. 관리자 페이지에서 수정한 글이 더 최신이면 다음 sync 때 storage Markdown도 갱신된다.

글의 `date`를 `YYYY-MM-DD`로만 적으면 사이트에는 날짜만 표시된다. 업로드 시각까지 직접 지정하려면 ISO 형식(예: `2026-07-12T11:27:22.000Z`)을 쓴다. `updatedAt`을 생략하거나 날짜만 적은 글은 Git 파일의 마지막 커밋 시각을 실제 수정 시각으로 사용한다.

### 수동으로 실행하는 법

GitHub 웹에서 실행하는 방법:

```txt
1. https://github.com/cha-amu/storage 로 이동
2. Actions 탭 클릭
3. Sync storage repo 선택
4. Run workflow 클릭
5. Branch가 main인지 확인
6. Run workflow 실행
```

수동 실행 후 같은 Actions 화면에서 실행 결과가 초록색 체크로 끝나면 성공이다. 실행 중 새 manifest나 Markdown 파일 변경이 생기면 `github-actions[bot]`이 `Sync storage manifests` 커밋을 자동으로 만든다.

### 제대로 됐는지 확인하는 법

Actions 화면에서 확인:

```txt
cha-amu/storage > Actions > Sync storage repo
```

성공하면 마지막 run이 초록색 체크로 표시된다.

사이트에 반영됐는지 확인:

```txt
https://cha-amu.github.io/storage/manifests/assets.json
https://cha-amu.github.io/storage/manifests/posts.json
```

각 manifest의 `generatedAt`이 최근 시간으로 바뀌고, 새 파일 경로가 `assets` 또는 `posts` 배열에 들어 있으면 storage Pages 쪽 반영은 끝난 것이다. 메인 사이트 `/archive/`는 이 manifest를 읽으므로, 브라우저 캐시 때문에 늦게 보이면 새로고침하면 된다.

### 로컬에서 미리 확인하는 법

Sheets를 건드리지 않고 manifest 생성만 확인하려면 storage repo에서 dry-run을 실행한다.

```sh
STORAGE_SYNC_DRY_RUN=1 npm run sync
```

이 명령은 Google Sheets에 쓰지 않고 `manifests/`와 `manifest.json` 생성 결과만 확인한다.

실제 Sheets까지 쓰는 로컬 sync는 Worker용 `STORAGE_SYNC_SECRET`이 필요하므로 보통 GitHub Actions 수동 실행을 쓴다. 관리자 비밀번호나 관리자 세션은 사용하지 않는다. API는 기본적으로 `https://cha-amu-gateway.yiyaaang.workers.dev/api`를 사용하며, 다른 Worker 주소가 필요할 때만 `API_URL`을 지정한다.

GitHub 저장소에는 Actions secret으로 `STORAGE_SYNC_SECRET`만 설정한다. `API_URL`은 repository variable로 덮어쓸 수 있으며, 모든 동기화 요청은 Worker에 Bearer 인증으로 전달된다.
