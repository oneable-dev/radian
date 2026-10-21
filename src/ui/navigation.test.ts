import { expect, test } from "bun:test";
import { halfPageStep } from "./navigation.ts";

test.each([
  [0, 1, 1], [1, 1, 1], [11, 1, 5], [11, 3, 1], [12, 3, 2], [20, 2, 5],
])("뷰포트 %i줄과 항목 간격 %i줄은 반 페이지에 %i개를 이동한다", (height, stride, expected) => {
  // 작은 뷰포트에서도 최소 한 항목을 이동하고 홀수 줄은 아래쪽으로 반올림하지 않는다.
  const distance = halfPageStep(height, stride);

  // 고정 키 횟수가 아니라 화면 높이와 각 표면의 실제 행 간격을 반영한다.
  expect(distance).toBe(expected);
});
