/** Queued WebUI message list displayed above the chat composer. */
import { useEffect, useRef } from "react";
import { CornerDownRight, Trash2 } from "lucide-react";
import { OverflowTooltipText } from "../components/overflow-tooltip-text.js";
import { Tooltip } from "../components/tooltip.js";
import type { AgentQueuedMessage } from "../state/agent-chat-slice.js";

export interface AgentQueuedMessageListProps {
  items: AgentQueuedMessage[];
  label: string;
  removeLabel: string;
  attachmentOnlyLabel: (count: number) => string;
  onRemove: (clientRequestId: string) => void;
}

function queuedMessageLabel(
  item: AgentQueuedMessage,
  attachmentOnlyLabel: (count: number) => string
): string {
  const normalized = item.content.replace(/\s+/gu, " ").trim();
  return normalized || attachmentOnlyLabel(item.media.length);
}

export function AgentQueuedMessageList(props: AgentQueuedMessageListProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const previousCountRef = useRef(props.items.length);

  useEffect(() => {
    if (props.items.length > previousCountRef.current) {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    }
    previousCountRef.current = props.items.length;
  }, [props.items.length]);

  if (!props.items.length) return null;

  return (
    <section className="agent-queue-panel" aria-label={props.label}>
      <ol ref={listRef} className="agent-queue-list" aria-live="polite">
        {props.items.map((item) => {
          const text = queuedMessageLabel(item, props.attachmentOnlyLabel);
          const removing = item.status === "removing";
          return (
            <li className="agent-queue-item" key={item.clientRequestId}>
              <CornerDownRight className="agent-queue-item__icon" size={14} aria-hidden="true" />
              <OverflowTooltipText className="agent-queue-item__text" text={text} />
              <Tooltip content={props.removeLabel}>
                <button
                  type="button"
                  className="agent-queue-item__remove"
                  aria-label={props.removeLabel}
                  disabled={removing}
                  onClick={() => props.onRemove(item.clientRequestId)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
