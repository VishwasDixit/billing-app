import { useEffect, useRef } from "react";

// Six digit boxes: auto-advance, backspace to go back, paste a whole code,
// and the phone keyboard can fill the code from the email (one-time-code).
export function OtpInput({ value, onChange, onComplete, error, disabled, autoFocus = true }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || "");

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const set = (next) => {
    const v = next.replace(/\D/g, "").slice(0, 6);
    onChange(v);
    if (v.length === 6) onComplete?.(v);
    return v;
  };

  const onInput = (i, raw) => {
    const typed = raw.replace(/\D/g, "");
    if (typed.length > 1) {
      // Pasted or auto-filled the whole code.
      const v = set(typed);
      refs.current[Math.min(v.length, 5)]?.focus();
      return;
    }
    const arr = digits.slice();
    arr[i] = typed;
    set(arr.join(""));
    if (typed && i < 5) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i, e) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      const arr = digits.slice();
      arr[i - 1] = "";
      onChange(arr.join(""));
      refs.current[i - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  };

  return (
    <div className={"otp-boxes" + (error ? " error" : "")} onPaste={(e) => (e.preventDefault(), set(e.clipboardData.getData("text")))}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={i === 0 ? 6 : 1}
          aria-label={`Digit ${i + 1}`}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
