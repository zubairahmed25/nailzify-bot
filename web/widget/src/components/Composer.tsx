import { useRef, useState } from "react";

const MAX_LENGTH = 1000;

export function Composer({
  onSend,
  onStop,
  busy,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (busy || !value.trim()) return;
    onSend(value);
    setValue("");
    // Reset the auto-grow, or the box keeps the height of the sent message.
    if (textarea.current) textarea.current.style.height = "auto";
  };

  return (
    <form
      class="nz-composer"
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
        placeholder="Ask about shapes, fit, wear time, returns…"
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
