import { useEffect, useState } from "react";
import type {
  AgentGoalControlAction,
  AgentGoalState
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";

export type AgentGoalControlRequest = {
  chatId: string;
  goalId: string;
  action: AgentGoalControlAction;
  objective?: string;
  tokenBudget?: number | null;
};

export interface AgentGoalBarProps {
  chatId: string;
  goal: AgentGoalState;
  pending: boolean;
  onControl: (request: AgentGoalControlRequest) => void;
}

type GoalForm =
  | { kind: "edit"; chatId: string; goalId: string; value: string }
  | { kind: "budget"; chatId: string; goalId: string; value: string };

const OBJECTIVE_MAX_LENGTH = 12_000;

export function AgentGoalBar(props: AgentGoalBarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<GoalForm | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const status = props.goal.status;
  const goalId = props.goal.goal_id;

  useEffect(() => {
    if (form && (form.chatId !== props.chatId || form.goalId !== goalId)) {
      setForm(null);
      setValidationError(null);
    }
  }, [form, goalId, props.chatId]);

  if (!status || !goalId) return null;

  const canResume = status === "paused" || status === "blocked" || status === "usage_limited";
  const canEdit = status !== "active" && status !== "completed";
  const canBudget = status !== "completed";
  const objectiveIsLong = props.goal.objective.length > 320 || props.goal.objective.includes("\n");

  const control = (action: AgentGoalControlAction) => {
    props.onControl({ chatId: props.chatId, goalId, action });
  };

  const openEdit = () => {
    setValidationError(null);
    setForm({ kind: "edit", chatId: props.chatId, goalId, value: props.goal.objective });
  };

  const openBudget = () => {
    setValidationError(null);
    setForm({
      kind: "budget",
      chatId: props.chatId,
      goalId,
      value: props.goal.token_budget === null ? "" : String(props.goal.token_budget)
    });
  };

  const submitForm = () => {
    if (!form) return;
    if (form.kind === "edit") {
      const objective = form.value.trim();
      if (!objective || objective.length > OBJECTIVE_MAX_LENGTH) {
        setValidationError(t("home.goal.objectiveInvalid"));
        return;
      }
      props.onControl({
        chatId: form.chatId,
        goalId: form.goalId,
        action: "edit",
        objective
      });
      return;
    }

    if (!/^[1-9]\d*$/.test(form.value.trim())) {
      setValidationError(t("home.goal.budgetInvalid"));
      return;
    }
    const tokenBudget = Number(form.value);
    if (!Number.isSafeInteger(tokenBudget)) {
      setValidationError(t("home.goal.budgetInvalid"));
      return;
    }
    props.onControl({
      chatId: form.chatId,
      goalId: form.goalId,
      action: "set_budget",
      tokenBudget
    });
  };

  return (
    <section className="agent-goal-bar" aria-label={t("home.goal.title")}>
      <div className="agent-goal-bar__header">
        <span className={`agent-goal-bar__status agent-goal-bar__status--${status}`}>
          {t(`home.goal.status.${status}`)}
        </span>
        <span className="agent-goal-bar__usage">
          {t("home.goal.usage", {
            used: props.goal.tokens_used,
            budget: props.goal.token_budget ?? t("home.goal.noLimit")
          })}
          {" · "}
          {t("home.goal.time", { seconds: props.goal.time_used_seconds })}
        </span>
      </div>

      <p className={expanded ? "agent-goal-bar__objective" : "agent-goal-bar__objective agent-goal-bar__objective--collapsed"}>
        {props.goal.objective}
      </p>
      {objectiveIsLong ? (
        <button type="button" className="agent-goal-bar__link" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("home.goal.collapse") : t("home.goal.expand")}
        </button>
      ) : null}

      {status === "usage_limited" ? <p className="agent-goal-bar__hint">{t("home.goal.usageLimitedHint")}</p> : null}
      {status === "budget_limited" ? <p className="agent-goal-bar__hint">{t("home.goal.budgetLimitedHint")}</p> : null}

      <div className="agent-goal-bar__actions">
        {status === "active" ? <GoalButton disabled={props.pending} onClick={() => control("pause")}>{t("home.goal.pause")}</GoalButton> : null}
        {canResume ? <GoalButton disabled={props.pending} onClick={() => control("resume")}>{t("home.goal.resume")}</GoalButton> : null}
        {canEdit ? <GoalButton disabled={props.pending} onClick={openEdit}>{t("common.edit")}</GoalButton> : null}
        {canBudget ? <GoalButton disabled={props.pending} onClick={openBudget}>{t("home.goal.budget")}</GoalButton> : null}
        <GoalButton disabled={props.pending} danger onClick={() => control("clear")}>{t("home.goal.clear")}</GoalButton>
      </div>

      {form ? (
        <div className="agent-goal-bar__form">
          {form.kind === "edit" ? (
            <textarea
              value={form.value}
              maxLength={OBJECTIVE_MAX_LENGTH + 1}
              disabled={props.pending}
              aria-label={t("home.goal.objective")}
              onChange={(event) => {
                setValidationError(null);
                setForm({ ...form, value: event.target.value });
              }}
            />
          ) : (
            <input
              value={form.value}
              inputMode="numeric"
              disabled={props.pending}
              aria-label={t("home.goal.budget")}
              placeholder={t("home.goal.budgetPlaceholder")}
              onChange={(event) => {
                setValidationError(null);
                setForm({ ...form, value: event.target.value });
              }}
            />
          )}
          {validationError ? <p role="alert" className="agent-goal-bar__validation">{validationError}</p> : null}
          <div className="agent-goal-bar__form-actions">
            <GoalButton disabled={props.pending} onClick={submitForm}>{t("common.save")}</GoalButton>
            {form.kind === "budget" ? (
              <GoalButton
                disabled={props.pending}
                onClick={() => props.onControl({
                  chatId: form.chatId,
                  goalId: form.goalId,
                  action: "set_budget",
                  tokenBudget: null
                })}
              >
                {t("home.goal.removeLimit")}
              </GoalButton>
            ) : null}
            <GoalButton disabled={props.pending} onClick={() => setForm(null)}>{t("common.cancel")}</GoalButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GoalButton(props: {
  children: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className={props.danger ? "agent-goal-bar__button agent-goal-bar__button--danger" : "agent-goal-bar__button"}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
