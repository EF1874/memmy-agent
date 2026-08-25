import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../../components/Icon";
import { locale, t } from "../../stores/i18n";

export interface DailyActivityPoint {
  date: string;
  count: number;
}

interface ActivityCell extends DailyActivityPoint {
  inRange: boolean;
}

interface ActivityWeek {
  key: string;
  cells: ActivityCell[];
}

export function DailyActivityCard({ values }: { values: DailyActivityPoint[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const weeks = buildWeeks(values);
  const maxCount = Math.max(0, ...values.map((item) => item.count));
  const gap = 3;
  const labelWidth = 34;
  const defaultCellSize = 10;
  const availableGridWidth = chartWidth > 0 ? Math.max(0, chartWidth - labelWidth - gap) : 0;
  const fittedCellSize = weeks.length > 0 && availableGridWidth > 0
    ? Math.floor((availableGridWidth - gap * (weeks.length - 1)) / weeks.length)
    : defaultCellSize;
  const cellSize = Math.max(6, Math.min(16, fittedCellSize));
  const gridWidth = weeks.length * cellSize + Math.max(0, weeks.length - 1) * gap;
  const language = locale.value === "zh" ? "zh-CN" : "en";
  const monthLabels = buildMonthLabels(weeks, language);
  const weekdays = buildWeekdayLabels(language);
  const total = values.reduce((sum, item) => sum + item.count, 0);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const update = () => setChartWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section class="card" data-daily-activity-card="true">
      <div class="card__header" style="margin-bottom:var(--sp-4)">
        <div>
          <h3 class="card__title" style="display:flex;align-items:center;gap:var(--sp-2)">
            <Icon name="bar-chart-3" size={16} />
            {t("overview.daily.title")}
          </h3>
          <p class="card__subtitle">{t("overview.daily.subtitle")}</p>
        </div>
        <span class="muted" style="font-size:var(--fs-xs);white-space:nowrap">
          {t("overview.daily.total", { count: total })}
        </span>
      </div>

      {weeks.length === 0 ? (
        <div class="empty__hint">{t("common.empty")}</div>
      ) : (
        <div ref={chartRef} style="width:100%;overflow:hidden;padding-bottom:2px">
          <div style={`width:${labelWidth + gap + gridWidth}px;max-width:100%`}>
            <div
              style={`display:grid;grid-template-columns:${labelWidth}px ${gridWidth}px;column-gap:${gap}px;margin-bottom:7px;color:var(--fg-dim);font-size:var(--fs-2xs);line-height:1`}
            >
              <span aria-hidden="true" />
              <div
                style={`display:grid;grid-template-columns:repeat(${weeks.length},${cellSize}px);column-gap:${gap}px;height:12px`}
              >
                {monthLabels.map((item) => (
                  <span
                    key={item.key}
                    data-activity-month-label={item.label}
                    style={`grid-column:${item.weekIndex + 1};white-space:nowrap`}
                  >
                    {item.label}
                  </span>
                ))}
              </div>
            </div>

            <div style={`display:grid;grid-template-columns:${labelWidth}px ${gridWidth}px;column-gap:${gap}px;align-items:start`}>
              <div
                style={`display:grid;grid-template-rows:repeat(7,${cellSize}px);row-gap:${gap}px;color:var(--fg-dim);font-size:var(--fs-2xs);line-height:${cellSize}px`}
              >
                {weekdays.map((label, index) => (
                  <span key={`${label}-${index}`}>{index === 1 || index === 3 || index === 5 ? label : ""}</span>
                ))}
              </div>
              <div
                role="img"
                aria-label={t("overview.daily.title")}
                style={`display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,${cellSize}px);grid-auto-columns:${cellSize}px;gap:${gap}px`}
              >
                {weeks.flatMap((week) => week.cells.map((cell) => {
                  const tooltip = t("overview.daily.count", {
                    date: formatDate(cell.date, language),
                    count: cell.count,
                  });
                  return (
                    <span
                      key={cell.date}
                      data-activity-cell={cell.date}
                      data-activity-count={cell.count}
                      title={tooltip}
                      aria-label={tooltip}
                      style={`display:block;width:${cellSize}px;height:${cellSize}px;border-radius:2px;background:${activityColor(cell, maxCount)};opacity:${cell.inRange ? 1 : 0.35}`}
                    />
                  );
                }))}
              </div>
            </div>

            <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:var(--sp-3);color:var(--fg-dim);font-size:var(--fs-2xs)">
              <span>{t("overview.daily.less")}</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span
                  key={level}
                  style={`display:block;width:${cellSize}px;height:${cellSize}px;border-radius:2px;background:${colorForLevel(level)}`}
                />
              ))}
              <span>{t("overview.daily.more")}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function buildWeeks(values: DailyActivityPoint[]): ActivityWeek[] {
  const sorted = values
    .filter((item) => parseDate(item.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];
  const counts = new Map(sorted.map((item) => [item.date, item.count]));
  const first = parseDate(sorted[0]!.date)!;
  const last = parseDate(sorted.at(-1)!.date)!;
  const start = addDays(first, -first.getUTCDay());
  const weeks: ActivityWeek[] = [];
  for (let weekStart = start; weekStart <= last; weekStart = addDays(weekStart, 7)) {
    const cells = Array.from({ length: 7 }, (_, day) => {
      const date = dateKey(addDays(weekStart, day));
      return { date, count: counts.get(date) ?? 0, inRange: counts.has(date) };
    });
    weeks.push({ key: dateKey(weekStart), cells });
  }
  return weeks;
}

function buildMonthLabels(weeks: ActivityWeek[], language: string): Array<{ key: string; label: string; weekIndex: number }> {
  const labels: Array<{ key: string; label: string; weekIndex: number }> = [];
  let previous = "";
  weeks.forEach((week, weekIndex) => {
    const visibleCell = week.cells.find((cell) => cell.inRange);
    if (!visibleCell) return;
    const month = visibleCell.date.slice(0, 7);
    if (month === previous) return;
    previous = month;
    const date = parseDate(`${month}-01`)!;
    labels.push({
      key: month,
      label: new Intl.DateTimeFormat(language, { month: "short", timeZone: "UTC" }).format(date),
      weekIndex,
    });
  });
  return labels;
}

function buildWeekdayLabels(language: string): string[] {
  const sunday = new Date(Date.UTC(2026, 0, 4));
  return Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(addDays(sunday, index)),
  );
}

function activityColor(cell: ActivityCell, maxCount: number): string {
  if (!cell.inRange || cell.count <= 0 || maxCount <= 0) return colorForLevel(0);
  return colorForLevel(Math.max(1, Math.min(4, Math.ceil((cell.count / maxCount) * 4))));
}

function colorForLevel(level: number): string {
  return [
    "color-mix(in srgb, var(--bg-hover) 70%, var(--bg-card))",
    "color-mix(in srgb, var(--success) 22%, var(--bg-card))",
    "color-mix(in srgb, var(--success) 42%, var(--bg-card))",
    "color-mix(in srgb, var(--success) 70%, var(--bg-card))",
    "color-mix(in srgb, var(--success) 88%, var(--fg))",
  ][level] ?? "var(--success)";
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string, language: string): string {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat(language, { month: "short", day: "numeric", timeZone: "UTC" }).format(date)
    : value;
}
