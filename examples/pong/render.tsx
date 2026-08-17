import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const elem = document.getElementById("root");

if (!elem) {
	throw new Error("Could not find root element");
}

const app = (
	<StrictMode>
		<App />
	</StrictMode>
);

if (import.meta.hot) {
	const hotData = import.meta.hot.data as Record<string, unknown>;
	if (!hotData.root) {
		hotData.root = createRoot(elem);
	}
	(hotData.root as ReturnType<typeof createRoot>).render(app);
} else {
	createRoot(elem).render(app);
}
