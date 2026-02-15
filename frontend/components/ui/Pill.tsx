import React from "react";

type PillProps = React.HTMLAttributes<HTMLSpanElement> & {
  asButton?: boolean;
  theme?: "dark" | "light";
};

export default function Pill(props: PillProps) {
  const { asButton, className, children, theme = "dark", ...rest } = props;
  const classes =
    theme === "dark"
      ? "px-2.5 py-1 rounded-full text-xs border border-white/10 bg-white/5 text-white/80 hover:bg-white/10 whitespace-nowrap max-w-full truncate"
      : "px-2.5 py-1 rounded-full text-xs border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 whitespace-nowrap max-w-full truncate";

  if (asButton) {
    return (
      <button type="button" className={`${classes} ${className || ""}`} {...(rest as any)}>
        {children}
      </button>
    );
  }

  return (
    <span className={`${classes} ${className || ""}`} {...rest}>
      {children}
    </span>
  );
}
