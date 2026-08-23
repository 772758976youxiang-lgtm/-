									className: DetailsPanel_module_css_default.title,
								children: file.title
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: { color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "transparent", border: "none", borderRadius: "6px", padding: "4px 8px", fontSize: "12px", flex: "none" },
									"aria-label": t("details.openExternal"),
									onClick: () => {
										openPath(file.path).catch(() => {});
									},
									children: t("details.openExternal")
								}),
