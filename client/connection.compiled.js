						/** @deepseek-ai 外部连接（IM 通道）设置页 · 读取桥接状态文件（由 Harness 统一管理） */
		function ExternalSection({ t, readStatus }) {
			const [items, setItems] = react.useState([]);
			(0, react.useEffect)(() => {
				let alive = true;
				const load = async () => {
					try {
						const list = await readStatus();
						if (alive && Array.isArray(list)) setItems(list);
					} catch {}
				};
				load();
				const timer = setInterval(load, 5000);
				return () => { alive = false; clearInterval(timer); };
			}, [readStatus]);
			const shown = items.filter((c) => c.status === "connected");
			const rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
			const dot = (c) => (0, react_jsx_runtime.jsx)("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" } });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: GeneralSection_module_css_default.section,
				children: [
					(0, react_jsx_runtime.jsx)("h1", { style: { margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: t("external.title") }),
					(0, react_jsx_runtime.jsx)("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }, children: t("external.intro") }),
					shown.length === 0 ? (0, react_jsx_runtime.jsx)("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px" }, children: "暂无已连接的 IM 通道。" }) :
					shown.map((c) => (0, react_jsx_runtime.jsxs)("div", { style: rowStyle, children: [
						(0, react_jsx_runtime.jsxs)("div", { style: { flex: "1", minWidth: "0" }, children: [
							(0, react_jsx_runtime.jsxs)("div", { style: { fontWeight: "600", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }, children: [ c.name, dot(c), (0, react_jsx_runtime.jsx)("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" }, children: "已连接" }) ] }),
							(0, react_jsx_runtime.jsx)("div", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", marginTop: "2px" }, children: c.mode === "stream" ? "Stream 模式 · 无需公网" : (c.mode ?? "") })
						] })
					] }, c.id))
