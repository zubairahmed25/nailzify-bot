import { useEffect, useRef, useState } from "react";

const MAX_LENGTH = 1000;

export interface ComposerFocusRequest {
  readonly id: number;
  readonly emphasize: boolean;
}

interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly busy: boolean;
  readonly focusRequest: ComposerFocusRequest;
  readonly placeholder: string;
}

export function Composer({
  onSend,
  onStop,
  busy,
  focusRequest,
  placeholder,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [showAttention, setShowAttention] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusRequest.id === 0) return;

    textarea.current?.focus({ preventScroll: true });
    if (!focusRequest.emphasize) return;

    setShowAttention(true);
    const timeout = window.setTimeout(() => setShowAttention(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [focusRequest.id, focusRequest.emphasize]);

  const submit = () => {
    if (busy || !value.trim()) return;
    onSend(value);
    setValue("");
    // Reset the auto-grow, or the box keeps the height of the sent message.
    if (textarea.current) textarea.current.style.height = "auto";
  };

  return (
    <form
      class={`nz-composer${showAttention ? " nz-composer--attention" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textarea}
        class="nz-input"
        rows={1}
        value={value}
        maxLength={MAX_LENGTH}
        placeholder={placeholder}
        aria-label="Message"
        onInput={(e) => {
          const el = e.currentTarget;
          setValue(el.value);
          // Grow with the content up to a cap, so a long question is readable
          // without the composer eating the conversation.
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
        }}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. On a phone the on-screen
          // return key should insert a newline instead — sending on Enter there
          // makes multi-line questions nearly impossible to type.
          if (e.key === "Enter" && !e.shiftKey && !isTouch()) {
            e.preventDefault();
            submit();
          }
        }}
      />

      {busy ? (
        <button type="button" class="nz-send nz-send--stop" onClick={onStop} aria-label="Stop">
          ■
        </button>
      ) : (
        <button type="submit" class="nz-send" disabled={!value.trim()} aria-label="Send message">
          ↑
        </button>
      )}
    </form>
  );
}

const isTouch = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
