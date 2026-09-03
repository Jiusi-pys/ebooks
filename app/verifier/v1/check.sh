#!/usr/bin/env bash
# 静态验收：关键能力存在性 + 类型检查 + 生产构建
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
mark() { if eval "$2" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

mark A1-tags "grep -q 'tags?: string\[\]' src/types/index.ts"
mark A2-cloze "grep -q 'cloze?: string\[\]' src/types/index.ts"
mark A3-review-field "grep -q 'review?: ReviewState' src/types/index.ts"
mark B1-review-view "test -f src/components/ReviewView.tsx && grep -q \"'review'\" src/types/index.ts"
mark B3-scheduler "test -f src/lib/srs.ts && grep -q 'gradeCard' src/lib/srs.ts"
mark D1-focus "grep -q 'focusNodeId' src/components/MindView.tsx"
mark D2-outline "grep -q 'outline' src/components/MindView.tsx"
mark E1-studyset "test -f src/components/StudySetView.tsx"
mark F1-events "grep -q 'review.updated' api/lib/webhooks.ts"
mark F2-due-api "grep -q '/review/due' api/v1.ts"
mark G1-typecheck "npm run check"
mark G2-build "npm run build"
exit $fail
