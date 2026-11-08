window.__ModuleLoader__.load({
	id: "dsh-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef } = React;

		const inject = ["slots"];

		function apply(ctx) {
			// settings.section 由 ui-settings-general 在运行时声明：
			// 必须先通过 ctx.slots.inject 声明贡献意图，等该 slot 就绪后再 register，
			// 否则注册会静默落空，设置页里看不到条目。
			ctx.effect(() => ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register(
						{ name: "settings.section", id: "dsh-hud-config", order: 31, label: () => "任务通知流HUD" },
						function DshHudSection() {
			const [cfg, setCfg] = useState({
				allRight: true,
				persistWorking: true,
				showRunningBubble: true,
				runningIdleTimeoutMin: 45,
				duration: 8500,
				screenPosition: "right",
				avatarType: "preset-purple",
				avatarColor: "#8b5cf6",
				avatarGradient: "linear-gradient(135deg, #a78bfa, #c084fc)",
				customAvatar: "",
				fontFamily: "system",
				fontSize: 14
			});
			const [loading, setLoading] = useState(true);
			const [hudOffline, setHudOffline] = useState(false);
			const [savedMsg, setSavedMsg] = useState("");
			const [systemFonts, setSystemFonts] = useState([]);
			const fileInputRef = useRef(null);

			const MONET_PALETTES = [
				{ name: "莫奈紫罗兰（默认）", value: "linear-gradient(135deg, #a78bfa, #c084fc)" },
				{ name: "睡莲池清溪", value: "linear-gradient(135deg, #6ee7b7, #3b82f6)" },
				{ name: "日落印象暖阳", value: "linear-gradient(135deg, #fbcfe8, #f59e0b)" },
				{ name: "雾中伦敦蓝珀", value: "linear-gradient(135deg, #93c5fd, #6366f1)" },
				{ name: "干草堆落霞", value: "linear-gradient(135deg, #fed7aa, #f43f5e)" }
			];

			const PRESET_FONTS = [
				{ id: "system", name: "系统默认 (苹方 / Segoe UI)" },
				{ id: "Microsoft YaHei", name: "微软雅黑 (Microsoft YaHei)" },
				{ id: "KaiTi", name: "优雅楷体 (KaiTi)" },
				{ id: "FangSong", name: "清秀仿宋 (FangSong)" },
				{ id: "Comic Sans MS", name: "圆润活泼体 (Comic Sans MS)" },
				{ id: "Consolas", name: "等宽程序员体 (Consolas)" }
			];

			useEffect(() => {
				fetch("http://127.0.0.1:52399/api/config")
					.then(r => r.json())
					.then(data => { setCfg(prev => ({ ...prev, ...data })); setHudOffline(false); setLoading(false); })
					.catch(() => { setHudOffline(true); setLoading(false); });

				fetch("http://127.0.0.1:52399/api/fonts")
					.then(r => r.json())
					.then(data => { if (Array.isArray(data.fonts)) setSystemFonts(data.fonts); })
					.catch(() => void 0);
			}, []);

			const save = (newPartial) => {
				fetch("http://127.0.0.1:52399/api/config")
					.then(r => r.json())
					.then(latest => {
						const next = { ...latest, ...newPartial };
						setCfg(next);
						fetch("http://127.0.0.1:52399/api/config", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(next)
						}).then(() => {
							setSavedMsg("配置已即时生效！");
							setTimeout(() => setSavedMsg(""), 2000);
						});
					})
					.catch(() => {
						const next = { ...cfg, ...newPartial };
						setCfg(next);
						fetch("http://127.0.0.1:52399/api/config", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(next)
						});
					});
			};

			const handleFileUpload = (e) => {
				const file = e.target.files?.[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = (evt) => {
					save({ avatarType: "custom", customAvatar: evt.target?.result });
				};
				reader.readAsDataURL(file);
			};

			return h("section", {
				className: "dsh-hud-cfg",
				style: { maxWidth: "740px", display: "flex", flexDirection: "column", gap: "16px", padding: "8px 0" },
				children: [
					h("div", {
						children: [
							h("h2", { style: { margin: 0, fontSize: "16px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: "任务通知流HUD" }),
							h("p", { style: { margin: "4px 0 0", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "屏幕贴边群唱（Cappella）风格任务通知流管理。支持屏幕左右贴边切换、头像自定义与选色、字体字号调节与状态常驻。" })
						]
					}),

					// 桌面进程未就绪提示：帮助其他机器定位「没有气泡」的原因
					hudOffline ? h("div", {
						style: {
							background: "rgba(245, 158, 11, 0.12)",
							border: "1px solid rgba(245, 158, 11, 0.35)",
							color: "var(--dsw-alias-label-primary)",
							borderRadius: "10px",
							padding: "12px 14px",
							fontSize: "12.5px",
							lineHeight: 1.6
						},
						children: [
							h("div", { style: { fontWeight: "600", marginBottom: "4px" }, children: "⚠ 桌面气泡窗口未运行" }),
							h("div", { children: "本插件需要一个 Electron 运行时来承载桌面悬浮窗。请确认已安装 Electron（例如 ~/.dsh/electron），或用环境变量 DSH_HUD_ELECTRON 指定可执行文件路径，然后重启 DSH。" })
						]
					}) : null,

					// 卡片 1：显示与位置管理
					h("div", {
						style: { background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" },
						children: [
							h("div", { style: { fontSize: "14px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: "屏幕位置与气泡排版" }),

							// 1. 屏幕最左 / 最右切换按钮
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "屏幕贴边位置" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "快速将通知流定位至屏幕最左或最右边缘。" })
										]
									}),
									h("div", {
										style: { display: "flex", background: "rgba(127,127,127,0.12)", padding: "3px", borderRadius: "8px", gap: "4px" },
										children: [
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: cfg.screenPosition === "left" ? "var(--dsw-alias-brand-primary, #3b82f6)" : "transparent",
													color: cfg.screenPosition === "left" ? "#fff" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ screenPosition: "left" }),
												children: "屏幕最左侧"
											}),
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: cfg.screenPosition === "right" ? "var(--dsw-alias-brand-primary, #3b82f6)" : "transparent",
													color: cfg.screenPosition === "right" ? "#fff" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ screenPosition: "right" }),
												children: "屏幕最右侧（默认）"
											})
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 2. 锁定 / 移动模式切换开关
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "悬浮窗自由拖动 (移动/锁定)" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "默认为锁定状态；切换为「移动模式」后，可直接用鼠标按住任意气泡拖动到屏幕任意位置！" })
										]
									}),
									h("div", {
										style: { display: "flex", background: "rgba(127,127,127,0.12)", padding: "3px", borderRadius: "8px", gap: "4px" },
										children: [
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: !cfg.isMovable ? "var(--dsw-alias-brand-primary, #3b82f6)" : "transparent",
													color: !cfg.isMovable ? "#fff" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ isMovable: false }),
												children: "🔒 锁定（默认）"
											}),
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: cfg.isMovable ? "#10b981" : "transparent",
													color: cfg.isMovable ? "#fff" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ isMovable: true }),
												children: "✋ 移动模式"
											}),
											h("button", {
												type: "button",
												title: "恢复至屏幕边缘初始默认位置",
												style: {
													border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
													padding: "4px 10px",
													borderRadius: "6px",
													fontSize: "12px",
													cursor: "pointer",
													background: "transparent",
													color: "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ screenPosition: "right", customX: null, customY: null, isMovable: false }),
												children: "↺ 返回默认位置"
											})
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 3. 气泡全部靠右
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "所有气泡统一在右侧排列" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "开启后所有气泡统一靠右整齐排列；关闭后气泡将在左右两侧随机交替弹出，模拟对话感。" })
										]
									}),
									h("input", {
										type: "checkbox",
										checked: cfg.allRight,
										style: { width: "18px", height: "18px", cursor: "pointer" },
										onChange: (e) => save({ allRight: e.target.checked })
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 4. 工作中状态常驻
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "工作中气泡持续常驻" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "只要 DSH 处于思考或工具调用中，最新气泡不消失，直至本轮完成。" })
										]
									}),
									h("input", {
										type: "checkbox",
										checked: cfg.persistWorking,
										style: { width: "18px", height: "18px", cursor: "pointer" },
										onChange: (e) => save({ persistWorking: e.target.checked })
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 常驻进行中气泡
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "常驻「进行中」气泡" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "任务没跑完就一直挂着一条气泡，并显示已运行时间，避免长任务被误判成已完成。默认开启。" })
										]
									}),
									h("input", {
										type: "checkbox",
										checked: cfg.showRunningBubble !== false,
										style: { width: "18px", height: "18px", cursor: "pointer" },
										onChange: (e) => save({ showRunningBubble: e.target.checked })
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 常驻气泡的静默兜底
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "静默兜底 (分钟)" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "这么久没有任何进度事件，就自动收起常驻气泡（默认 45 分钟）。用于任务异常中断、结束事件丢失的情况。" })
										]
									}),
									h("input", {
										type: "number",
										value: cfg.runningIdleTimeoutMin ?? 45,
										step: 5,
										min: 1,
										style: { width: "85px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
										onChange: (e) => save({ runningIdleTimeoutMin: Number(e.target.value) })
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 5. 停留时长
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "完成气泡停留时长 (毫秒)" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "任务结束后完成提示在屏幕停留的时间（默认 8500ms）。" })
										]
									}),
									h("input", {
										type: "number",
										value: cfg.duration,
										step: 500,
										min: 2000,
										style: { width: "85px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
										onChange: (e) => save({ duration: Number(e.target.value) })
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 6. 气泡明暗色彩主题切换
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "气泡明暗主题" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "选择白色纯净毛玻璃风格，或者深邃暗色磨砂风格。" })
										]
									}),
									h("div", {
										style: { display: "flex", background: "rgba(127,127,127,0.12)", padding: "3px", borderRadius: "8px", gap: "4px" },
										children: [
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: cfg.bubbleTheme !== "dark" ? "var(--dsw-alias-brand-primary, #3b82f6)" : "transparent",
													color: cfg.bubbleTheme !== "dark" ? "#fff" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ bubbleTheme: "light" }),
												children: "☀️ 白色毛玻璃"
											}),
											h("button", {
												type: "button",
												style: {
													border: "none",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													fontWeight: "500",
													cursor: "pointer",
													background: cfg.bubbleTheme === "dark" ? "#1e293b" : "transparent",
													color: cfg.bubbleTheme === "dark" ? "#38bdf8" : "var(--dsw-alias-label-secondary)"
												},
												onClick: () => save({ bubbleTheme: "dark" }),
												children: "🌙 暗色磨砂"
											})
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 7. 气泡背景透明度滑动条
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "气泡背景透明度" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "手动拖动调节毛玻璃透明度（20% ~ 100%）。" })
										]
									}),
									h("div", {
										style: { display: "flex", alignItems: "center", gap: "10px" },
										children: [
											h("input", {
												type: "range",
												min: 20,
												max: 100,
												step: 5,
												value: cfg.bubbleOpacity !== undefined ? cfg.bubbleOpacity : 85,
												style: { width: "120px", cursor: "pointer" },
												onChange: (e) => save({ bubbleOpacity: Number(e.target.value) })
											}),
											h("span", {
												style: { width: "42px", fontSize: "13px", fontWeight: "500", color: "var(--dsw-alias-label-secondary)", textAlign: "right" },
												children: `${cfg.bubbleOpacity !== undefined ? cfg.bubbleOpacity : 85}%`
											})
										]
									})
								]
							})
						]
					}),

					// 卡片 2：头像修改与选色
					h("div", {
						style: { background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" },
						children: [
							h("div", { style: { fontSize: "14px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: "头像外观设置" }),

							// 自定义图片上传
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "上传自定义头像图片" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "从电脑本地选择一张图片（PNG/JPG/WebP/GIF）作为气泡头像。" })
										]
									}),
									h("div", {
										style: { display: "flex", gap: "8px", alignItems: "center" },
										children: [
											h("input", {
												type: "file",
												ref: fileInputRef,
												accept: "image/*",
												style: { display: "none" },
												onChange: handleFileUpload
											}),
											h("button", {
												type: "button",
												style: {
													border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
													background: "transparent",
													padding: "4px 12px",
													borderRadius: "6px",
													fontSize: "12.5px",
													color: "var(--dsw-alias-label-primary)",
													cursor: "pointer"
												},
												onClick: () => fileInputRef.current?.click(),
												children: "选择图片..."
											}),
											cfg.avatarType === "custom" && cfg.customAvatar ? h("button", {
												type: "button",
												style: {
													border: "none",
													background: "rgba(239, 68, 68, 0.15)",
													color: "#ef4444",
													padding: "4px 10px",
													borderRadius: "6px",
													fontSize: "12px",
													cursor: "pointer"
												},
												onClick: () => save({ avatarType: "preset-purple", customAvatar: "" }),
												children: "恢复默认"
											}) : null
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 纯色选色轮盘
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "自选纯色头像 (选色轮盘)" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "点击色块打开系统选色轮盘，自由选择任何纯色背景。" })
										]
									}),
									h("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											h("input", {
												type: "color",
												value: cfg.avatarColor?.startsWith("#") && cfg.avatarColor.length === 7 ? cfg.avatarColor : "#8b5cf6",
												style: { width: "36px", height: "30px", border: "none", borderRadius: "6px", cursor: "pointer", background: "transparent" },
												onChange: (e) => save({ avatarType: "color", avatarColor: e.target.value })
											}),
											h("input", {
												type: "text",
												placeholder: "#8b5cf6",
												value: cfg.avatarColor || "#8b5cf6",
												style: {
													width: "82px",
													padding: "4px 8px",
													borderRadius: "6px",
													border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
													background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.15))",
													color: "var(--dsw-alias-label-primary)",
													fontSize: "12.5px",
													fontFamily: "monospace",
													textAlign: "center"
												},
												onChange: (e) => {
													const val = e.target.value.trim();
													setCfg(prev => ({ ...prev, avatarColor: val }));
													if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
														save({ avatarType: "color", avatarColor: val });
													}
												},
												onBlur: (e) => {
													const val = e.target.value.trim();
													if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
														save({ avatarType: "color", avatarColor: val });
													}
												}
											})
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 莫奈取色渐变色
							h("div", {
								style: { display: "flex", flexDirection: "column", gap: "8px" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "莫奈取色渐变色头像" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "精选莫奈画作印象派经典渐变配色，点击直接应用。" })
										]
									}),
									h("div", {
										style: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "4px" },
										children: MONET_PALETTES.map((pal, idx) => h("button", {
											key: idx,
											type: "button",
											title: pal.name,
											style: {
												width: "36px",
												height: "36px",
												borderRadius: "50%",
												border: cfg.avatarType === (idx === 0 ? "preset-purple" : "monet") && cfg.avatarGradient === pal.value ? "2.5px solid var(--dsw-alias-brand-primary, #3b82f6)" : "1.5px solid rgba(255,255,255,0.4)",
												backgroundImage: pal.value,
												cursor: "pointer",
												boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
												position: "relative"
											},
											onClick: () => save({ avatarType: idx === 0 ? "preset-purple" : "monet", avatarGradient: pal.value })
										}))
									})
								]
							})
						]
					}),

					// 卡片 3：字体与字号设置
					h("div", {
						style: { background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "14px" },
						children: [
							h("div", { style: { fontSize: "14px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: "气泡字体与排版" }),

							// 字体家族
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "对话气泡字体" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "支持常用字体，并已自动检索系统安装的 200+ 款全部字体！" })
										]
									}),
									h("select", {
										value: cfg.fontFamily || "system",
										style: { padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: "12.5px", maxWidth: "230px" },
										onChange: (e) => save({ fontFamily: e.target.value }),
										children: [
											h("optgroup", {
												label: "── 常用推荐字体 ──",
												children: PRESET_FONTS.map(f => h("option", { key: f.id, value: f.id, children: f.name }))
											}),
											systemFonts.length > 0 ? h("optgroup", {
												label: `── 系统安装字体 (${systemFonts.length} 款) ──`,
												children: systemFonts.map(f => h("option", { key: f, value: f, children: f }))
											}) : null
										]
									})
								]
							}),

							h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

							// 字体大小
							h("div", {
								style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
								children: [
									h("div", {
										children: [
											h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "气泡正文字号 (px)" }),
											h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "范围 12 ~ 22px，默认 14px。" })
										]
									}),
									h("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											h("input", {
												type: "range",
												min: 12,
												max: 22,
												value: cfg.fontSize || 14,
												style: { width: "110px", cursor: "pointer" },
												onChange: (e) => save({ fontSize: Number(e.target.value) })
											}),
											h("span", { style: { fontSize: "13px", fontWeight: "600", width: "36px", textAlign: "right", color: "var(--dsw-alias-label-primary)" }, children: `${cfg.fontSize || 14}px` })
										]
									})
								]
							})
						]
					}),

					savedMsg ? h("div", { style: { color: "#10b981", fontSize: "13px", fontWeight: "600", padding: "4px 0" }, children: savedMsg }) : null
				]
			});
						}
					);
				} catch (error) {
					try { console.error("[dsh-hud] settings section register failed:", error); } catch (_e) {}
					return () => {};
				}
			}), "dsh-hud: settings section");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
