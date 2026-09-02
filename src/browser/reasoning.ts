import { createElement, type FC, type HTMLAttributes } from "react";

export interface PlainReasoningContentProps extends HTMLAttributes<HTMLDivElement> {
  hasContent?: boolean;
  isStreaming?: boolean;
}

export const PlainReasoningContent: FC<PlainReasoningContentProps> = ({
  children,
  className,
  hasContent,
  isStreaming,
  ...props
}) => {
  if (!hasContent && !isStreaming) return null;
  const content = typeof children === "string" ? children : "";
  const classes = ["reasoning-content", className].filter(Boolean).join(" ");
  return createElement("div", { ...props, className: classes }, content);
};
