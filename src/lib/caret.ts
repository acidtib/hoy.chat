// Pixel coordinates of the caret inside a <textarea>, via the mirror-div
// technique (after component/textarea-caret-position). Returns top/left/height
// relative to the textarea's border box, already accounting for scroll. Used to
// anchor the @ context picker at the caret, Zed-style (HOY-220).

// Style properties copied to the mirror so its text wraps exactly like the
// textarea's, making the measured span position match the real caret.
const PROPERTIES = [
  "direction",
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
];

export interface CaretCoords {
  top: number;
  left: number;
  height: number;
}

export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoords {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const style = div.style as unknown as Record<string, string>;
  const computed = window.getComputedStyle(element) as unknown as Record<
    string,
    string
  >;

  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.position = "absolute";
  style.visibility = "hidden";
  for (const prop of PROPERTIES) {
    const value = computed[prop];
    if (value != null) style[prop] = value;
  }
  style.overflow = "hidden";

  div.textContent = element.value.slice(0, position);
  const span = document.createElement("span");
  // A trailing space/char gives the span a box to measure when the caret sits at
  // the very end of the value.
  span.textContent = element.value.slice(position) || ".";
  div.appendChild(span);

  const lineHeight =
    parseInt(computed.lineHeight, 10) ||
    parseInt(computed.fontSize, 10) * 1.2 ||
    16;
  const coords: CaretCoords = {
    top:
      span.offsetTop +
      parseInt(computed.borderTopWidth, 10) -
      element.scrollTop,
    left:
      span.offsetLeft +
      parseInt(computed.borderLeftWidth, 10) -
      element.scrollLeft,
    height: lineHeight,
  };
  document.body.removeChild(div);
  return coords;
}
