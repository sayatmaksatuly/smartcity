import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  MapPin,
  MessageCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { ru } from "../i18n/ru";
import type { POI } from "../types";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  mode?: "gemini" | "local";
  places?: { id: string; name: string }[];
};

export type ChatPanelProps = {
  open: boolean;
  onToggle: () => void;
  messages: ChatMessage[];
  busy: boolean;
  error: string;
  onSend: (text: string) => void;
  onRetry: () => void;
  onReset: () => void;
  onSelect: (id: string) => void;
  selected: string | null;
  currentPlaceIds?: string[];
  contextSummary?: string;
  suggestions?: POI[];
  needsOrigin?: boolean;
  onConfirmOrigin: (poi: POI) => void;
  onChooseOrigin: () => void;
  onUseCurrentOrigin?: () => void;
};

const MAX_MESSAGE_LENGTH = 600;

export default function ChatPanel({
  open,
  onToggle,
  messages,
  busy,
  error,
  onSend,
  onRetry,
  onReset,
  onSelect,
  selected,
  currentPlaceIds,
  contextSummary,
  suggestions = [],
  needsOrigin = false,
  onConfirmOrigin,
  onChooseOrigin,
  onUseCurrentOrigin,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const panelId = useId();
  const inputId = useId();
  const hintId = useId();
  const history = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const submissionLocked = useRef(false);
  const latestMessageId = messages.at(-1)?.id;

  useEffect(() => {
    if (open && history.current) {
      history.current.scrollTop = history.current.scrollHeight;
    }
  }, [open, latestMessageId, busy]);

  useEffect(() => {
    if (!busy) submissionLocked.current = false;
  }, [busy, latestMessageId, error]);

  function send(text = draft) {
    const cleaned = text.trim();
    if (
      busy ||
      submissionLocked.current ||
      !cleaned ||
      cleaned.length > MAX_MESSAGE_LENGTH
    ) {
      return;
    }
    submissionLocked.current = true;
    setDraft("");
    onSend(cleaned);
  }

  function reset() {
    setDraft("");
    submissionLocked.current = false;
    onReset();
    input.current?.focus({ preventScroll: true });
  }

  return (
    <section className="chat-panel" aria-label={ru.chatTitle}>
      <button
        type="button"
        className="chat-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <MessageCircle size={17} aria-hidden="true" />
        <span>
          <strong>{ru.chatTitle}</strong>
          <span>{ru.chatSubtitle}</span>
        </span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open} className="chat-body">
        <div className="chat-toolbar">
          <span>{ru.chatMemory}</span>
          <button type="button" onClick={reset} className="chat-reset">
            <RotateCcw size={12} aria-hidden="true" />
            {ru.chatReset}
          </button>
        </div>
        <div
          ref={history}
          className="chat-history"
          role="log"
          aria-label={ru.chatHistory}
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={busy}
          tabIndex={messages.length ? 0 : undefined}
        >
          {messages.slice(-8).map((message) => (
            <article
              key={message.id}
              className={`chat-message ${message.role}`}
              data-testid="chat-message"
              data-role={message.role}
            >
              <span className="chat-speaker">
                {message.role === "user" ? ru.chatYou : ru.chatAssistant}
              </span>
              <p>{message.text}</p>
              {!!message.places?.length && (
                <ol className="chat-places">
                  {message.places.map((place, index) => {
                    const mapIndex = currentPlaceIds
                      ? currentPlaceIds.indexOf(place.id)
                      : index;
                    return (
                      <li key={place.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(place.id)}
                          aria-pressed={selected === place.id}
                          aria-label={`${ru.onMap}: ${place.name}`}
                          data-testid="chat-place"
                        >
                          <span
                            className="chat-place-number"
                            aria-hidden="true"
                          >
                            {mapIndex >= 0 ? (
                              String(mapIndex + 1).padStart(2, "0")
                            ) : (
                              <MapPin size={16} />
                            )}
                          </span>
                          <span>{place.name}</span>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {message.mode && (
                <span className={`chat-mode ${message.mode}`}>
                  {message.mode === "gemini" ? ru.geminiMode : ru.chatLocalMode}
                </span>
              )}
            </article>
          ))}
        </div>
        {busy && (
          <p className="chat-loading" role="status">
            <RefreshCw size={13} className="spin" aria-hidden="true" />
            {ru.chatLoading}
          </p>
        )}
        {(needsOrigin || suggestions.length > 0) && (
          <div className="chat-origin">
            <p>{ru.chatOriginHeading}</p>
            {suggestions.map((poi) => (
              <button
                key={poi.id}
                type="button"
                onClick={() => onConfirmOrigin(poi)}
                disabled={busy}
                aria-label={`${ru.setOrigin}: ${poi.name}`}
              >
                <MapPin size={14} aria-hidden="true" />
                <span>{poi.name}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            ))}
            {needsOrigin && onUseCurrentOrigin && (
              <button
                type="button"
                onClick={onUseCurrentOrigin}
                disabled={busy}
              >
                <MapPin size={14} aria-hidden="true" />
                {ru.chatCurrentOrigin}
              </button>
            )}
            <button
              type="button"
              className="chat-choose-origin"
              onClick={onChooseOrigin}
            >
              <MapPin size={14} aria-hidden="true" />
              {ru.chatChooseOrigin}
            </button>
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={onRetry} disabled={busy}>
              <RefreshCw size={13} aria-hidden="true" />
              {ru.retry}
            </button>
          </div>
        )}
        {contextSummary && (
          <p className="chat-context" aria-label={ru.appliedConditions}>
            {contextSummary}
          </p>
        )}
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor={inputId}>{ru.chatInputLabel}</label>
          <div className="chat-input-row">
            <textarea
              id={inputId}
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={ru.chatPlaceholder}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={2}
              aria-describedby={hintId}
              disabled={busy}
            />
            <button
              type="submit"
              className="chat-send"
              aria-label={ru.chatSend}
              disabled={busy || !draft.trim()}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="chat-input-hint" id={hintId}>
            <span>{ru.chatKeyboardHint}</span>
            <span>{ru.chatLength(draft.length, MAX_MESSAGE_LENGTH)}</span>
          </div>
        </form>
        {!messages.length && (
          <div className="chat-welcome">
            <p>{ru.chatWelcome}</p>
            <div className="chat-prompts" aria-label={ru.chatPromptsLabel}>
              {ru.chatPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt)}
                  disabled={busy}
                >
                  {prompt}
                  <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
