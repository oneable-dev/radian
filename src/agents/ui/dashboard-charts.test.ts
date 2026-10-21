import { expect, test } from "bun:test";
import { emptyDashboard } from "../dashboard.ts";
import { dashboardBars, dashboardTrend, dashboardValue } from "./dashboard-charts.ts";

test("활동 없는 그래프는 0과 날짜를 유지하고 실제 소비처럼 채운 막대를 그리지 않는다", () => {
  // 빈 데이터는 누락 오류와 달리 정상적인 0이다.
  const snapshot = emptyDashboard(7, new Date(2026, 2, 22, 12).getTime());

  // 일별 그래프와 빈 순위를 화면 문자열로 표현한다.
  const trend = dashboardTrend(snapshot.daily, "tokens", 80).join("\n"), bars = dashboardBars([], 80);

  // 잘못된 비율이나 가짜 활동을 만들지 않는다.
  expect(trend).toContain("0"); expect(trend).toContain("03-22"); expect(trend).not.toContain("█"); expect(trend).not.toContain("NaN");
  expect(bars).toEqual(["No recorded usage in this period."]);
});

test.each([20, 40, 80, 112])("%d열 그래프는 한글·이모지 이름과 큰 숫자가 있어도 터미널 셀 너비를 넘지 않는다", width => {
  // 문자 길이가 아닌 실제 터미널 셀 너비를 기준으로 레이아웃해야 한다.
  const rows = [{ name: "한글 스킬 👩🏽‍💻 긴 이름이 계속됩니다", value: 123456 }, { name: "review-code", value: 200 }];
  const snapshot = emptyDashboard(30); snapshot.daily[0]!.tokens = 123456;

  // 좁은 화면에서 긴 순위와 30일 추이를 축약한다.
  const lines = [...dashboardBars(rows, width), ...dashboardTrend(snapshot.daily, "tokens", width)];

  // 경계가 반쪽 grapheme이나 레이아웃 초과로 깨지지 않는다.
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  expect(lines.join("\n")).not.toContain("NaN");
});

test("실행 시간과 토큰 값은 서로 다른 단위로 표시한다", () => {
  // 밀리초를 토큰처럼 그대로 보여주면 지표 의미가 달라진다.
  const durationMs = 3661000, tokens = 123456;

  // 같은 요약 포맷 경계에서 지표별로 변환한다.
  const time = dashboardValue(durationMs, "durationMs"), consumption = dashboardValue(tokens);

  // 시간은 시간·분이며 토큰은 정확한 수치다.
  expect(time).toBe("1h 1m"); expect(consumption).toBe("123,456");
});
