import { renderToStaticMarkup as render } from "react-dom/server";

// The browser suite's test ids and states are inert attributes. Markup tests check the app's own
// markup, so they render without them.
export const withoutTestAttributes = (html: string) =>
  html.replace(/ data-(?:testid|state)="[^"]*"/g, "");

export const renderToStaticMarkup = (...args: Parameters<typeof render>) =>
  withoutTestAttributes(render(...args));
