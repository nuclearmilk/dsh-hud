window.__ModuleLoader__.load({
	id: "dsh-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const inject = ["slots"];
		const DEFAULT_CONTROL_PORT = 52399;
		const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB raw upload guard
		const MAX_GIF_PASSTHROUGH_BYTES = 300 * 1024;
		const AVATAR_SIZE = 128;

		function compressAvatarFile(file) {
			return new Promise((resolve, reject) => {
				if (!file || !String(file.type || "").startsWith("image/")) {
					return reject(new Error("请选择图片文件（PNG / JPG / WebP / GIF）"));
				}
				if (file.size > MAX_UPLOAD_BYTES) {
					return reject(new Error("图片体积超过 10MB，请选择更小的图片"));
				}

				const reader = new FileReader();
				reader.onerror = () => reject(new Error("读取图片失败"));
				reader.onload = (evt) => {
					const rawDataUrl = evt.target?.result;
					if (typeof rawDataUrl !== "string") return reject(new Error("读取图片失败"));

					// 小体积 GIF 直接保留动图
					if (file.type === "image/gif" && file.size <= MAX_GIF_PASSTHROUGH_BYTES) {
						return resolve(rawDataUrl);
					}

					const img = new Image();
					img.onerror = () => reject(new Error("图片解码失败"));
					img.onload = () => {
						try {
							const canvas = document.createElement("canvas");
							canvas.width = AVATAR_SIZE;
							canvas.height = AVATAR_SIZE;
							const ctx2d = canvas.getContext("2d");
							if (!ctx2d) return resolve(rawDataUrl);

							// Center-crop square cover
							const sw = img.naturalWidth || img.width || AVATAR_SIZE;
							const sh = img.naturalHeight || img.height || AVATAR_SIZE;
							const side = Math.min(sw, sh);
							const sx = Math.floor((sw - side) / 2);
							const sy = Math.floor((sh - side) / 2);
							ctx2d.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
							ctx2d.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

							let compressed = canvas.toDataURL("image/webp", 0.85);
							if (!compressed.startsWith("data:image/webp;base64,")) {
								compressed = canvas.toDataURL("image/png");
							}
							resolve(compressed);
						} catch (err) {
							reject(new Error("图片压缩失败"));
						}
					};
					img.src = rawDataUrl;
				};
				reader.readAsDataURL(file);
			});
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register(
						{ name: "settings.section", id: "dsh-hud-config", order: 31, label: () => "任务通知流HUD" },
						function DshHudSection() {
							const [cfg, setCfg] = useState({
								allRight: true,
								persistWorking: true,
								showRunningBubble: true,
								showWaitingBubble: true,
								waitingSound: false,
								runningIdleTimeoutMin: 45,
								duration: 8500,
								screenPosition: "right",
								isMovable: false,
								bubbleTheme: "light",
								bubbleOpacity: 85,
								avatarType: "preset-purple",
								avatarColor: "#8b5cf6",
								avatarGradient: "linear-gradient(135deg, #a78bfa, #c084fc)",
								customAvatar: "",
								fontFamily: "system",
								fontSize: 14
							});
							const [connecting, setConnecting] = useState(true);
							const [hudOffline, setHudOffline] = useState(false);
							const [toast, setToast] = useState({ text: "", isError: false });
							const [systemFonts, setSystemFonts] = useState([]);
							const [idleMinDraft, setIdleMinDraft] = useState("45");
							const [durationDraft, setDurationDraft] = useState("8500");

							const fileInputRef = useRef(null);
							const controlRef = useRef({ port: DEFAULT_CONTROL_PORT, token: "" });
							const mountedRef = useRef(true);
							const savedTimerRef = useRef(null);
							const retryTimerRef = useRef(null);
							const retryCountRef = useRef(0);
							const debounceTimerRef = useRef(null);
							const pendingPatchRef = useRef({});
							const flushInFlightRef = useRef(false);

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

							const showToast = useCallback((text, isError = false) => {
								if (!mountedRef.current) return;
								if (savedTimerRef.current) {
									clearTimeout(savedTimerRef.current);
									savedTimerRef.current = null;
								}
								setToast({ text, isError });
								savedTimerRef.current = setTimeout(() => {
									savedTimerRef.current = null;
									if (mountedRef.current) setToast({ text: "", isError: false });
								}, 2200);
							}, []);

							const refreshControlInfo = useCallback(async () => {
								try {
									const res = await fetch("/dsh-hud/control-info", { cache: "no-store" });
									if (res.ok) {
										const info = await res.json();
										if (info && typeof info.port === "number" && info.port > 0) {
											controlRef.current = {
												port: info.port,
												token: typeof info.token === "string" ? info.token : ""
											};
											return true;
										}
									}
								} catch (_e) {
									// Fallback to default local port
								}
								return false;
							}, []);

							const apiFetch = useCallback(async (pathname, options = {}, retried401 = false) => {
								const { port, token } = controlRef.current;
								const headers = { ...(options.headers || {}) };
								if (token) headers["X-DSH-HUD-Token"] = token;
								const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...options, headers });
								if (res.status === 401 && !retried401) {
									const refreshed = await refreshControlInfo();
									if (refreshed) {
										return apiFetch(pathname, options, true);
									}
								}
								if (!res.ok) {
									const errText = await res.text().catch(() => "");
									throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ""}`);
								}
								return res.json();
							}, [refreshControlInfo]);

							const connectHud = useCallback(async ({ isRetry = false } = {}) => {
								if (!mountedRef.current) return;
								if (!isRetry) setConnecting(true);
								if (retryTimerRef.current) {
									clearTimeout(retryTimerRef.current);
									retryTimerRef.current = null;
								}

								try {
									await refreshControlInfo();
									const data = await apiFetch("/api/config");
									if (!mountedRef.current) return;
									setCfg((prev) => ({ ...prev, ...data }));
									if (data && data.runningIdleTimeoutMin !== undefined) {
										setIdleMinDraft(String(data.runningIdleTimeoutMin));
									}
									if (data && data.duration !== undefined) {
										setDurationDraft(String(data.duration));
									}
									setHudOffline(false);
									setConnecting(false);
									retryCountRef.current = 0;

									apiFetch("/api/fonts")
										.then((f) => {
											if (mountedRef.current && Array.isArray(f?.fonts)) {
												setSystemFonts(f.fonts);
											}
										})
										.catch(() => {});
								} catch (_err) {
									if (!mountedRef.current) return;
									setHudOffline(true);
									setConnecting(false);
									// 启动默认延迟 3 秒，刚打开设置页时自动轮询重试最多 5 次
									if (retryCountRef.current < 5) {
										retryCountRef.current += 1;
										retryTimerRef.current = setTimeout(() => {
											retryTimerRef.current = null;
											void connectHud({ isRetry: true });
										}, 1500);
									}
								}
							}, [apiFetch, refreshControlInfo]);

							useEffect(() => {
								mountedRef.current = true;
								void connectHud();
								return () => {
									mountedRef.current = false;
									if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
									if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
									if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

									// 卸载前若仍有防抖中未发送的变更，立即以 keepalive 发出，避免丢失最后一次拖动
									const pending = pendingPatchRef.current;
									if (pending && Object.keys(pending).length > 0) {
										pendingPatchRef.current = {};
										const { port, token } = controlRef.current;
										const headers = { "Content-Type": "application/json" };
										if (token) headers["X-DSH-HUD-Token"] = token;
										fetch(`http://127.0.0.1:${port}/api/config`, {
											method: "POST",
											headers,
											body: JSON.stringify(pending),
											keepalive: true
										}).catch(() => {});
									}
								};
							}, [connectHud]);

							const flushPendingPatch = useCallback(async () => {
								if (flushInFlightRef.current) return;
								const batch = pendingPatchRef.current;
								const keys = Object.keys(batch);
								if (!keys.length) return;

								pendingPatchRef.current = {};
								flushInFlightRef.current = true;

								try {
									const resp = await apiFetch("/api/config", {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify(batch)
									});
									if (!mountedRef.current) return;
									setHudOffline(false);
									// 仅在没有更新中的队列时回填服务端规范化后的配置，避免乱序覆盖用户正在拖动的滑块
									if (resp?.config && Object.keys(pendingPatchRef.current).length === 0) {
										setCfg((prev) => ({ ...prev, ...resp.config }));
									}
									showToast("配置已即时生效！");
								} catch (_err) {
									if (mountedRef.current) {
										setHudOffline(true);
										showToast("保存失败：桌面气泡窗口未连接", true);
									}
								} finally {
									flushInFlightRef.current = false;
									if (mountedRef.current && Object.keys(pendingPatchRef.current).length > 0) {
										void flushPendingPatch();
									}
								}
							}, [apiFetch, showToast]);

							const save = useCallback((newPartial, { debounceMs = 0 } = {}) => {
								setCfg((prev) => ({ ...prev, ...newPartial }));
								pendingPatchRef.current = { ...pendingPatchRef.current, ...newPartial };

								if (debounceTimerRef.current) {
									clearTimeout(debounceTimerRef.current);
									debounceTimerRef.current = null;
								}

								if (debounceMs > 0) {
									debounceTimerRef.current = setTimeout(() => {
										debounceTimerRef.current = null;
										void flushPendingPatch();
									}, debounceMs);
								} else {
									void flushPendingPatch();
								}
							}, [flushPendingPatch]);

							const sendTestBubble = useCallback(async (mode = "preview") => {
								try {
									const isWaitingPreview = mode !== "preview";
									await apiFetch("/api/test-bubble", {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({
											mode,
											text: isWaitingPreview
												? "bash：请求执行需要批准的命令（演示）"
												: "这是一条测试气泡，用于预览当前位置、主题与字体效果 ✨"
										})
									});
									showToast(isWaitingPreview ? "等待提醒预览已发送（6秒后自动收起）！" : "测试气泡已发送！");
								} catch (_err) {
									setHudOffline(true);
									showToast("发送失败：桌面气泡窗口未连接", true);
								}
							}, [apiFetch, showToast]);

							const handleFileUpload = async (e) => {
								const input = e.target;
								const file = input.files?.[0];
								input.value = "";
								if (!file) return;
								try {
									const dataUrl = await compressAvatarFile(file);
									save({ avatarType: "custom", customAvatar: dataUrl });
								} catch (err) {
									showToast(err?.message || "头像处理失败", true);
								}
							};

							const optionStyle = {
								backgroundColor: "var(--dsw-alias-bg-layer-1, #1e293b)",
								color: "var(--dsw-alias-label-primary, #f1f5f9)"
							};

							return h("section", {
								className: "dsh-hud-cfg",
								style: { maxWidth: "740px", display: "flex", flexDirection: "column", gap: "16px", padding: "8px 0" },
								children: [
									h("div", {
										style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" },
										children: [
											h("div", {
												children: [
													h("h2", { style: { margin: 0, fontSize: "16px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: "任务通知流HUD" }),
													h("p", { style: { margin: "4px 0 0", fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "屏幕贴边群唱（Cappella）风格任务通知流管理。支持屏幕左右贴边切换、头像自定义与选色、字体字号调节与状态常驻。" })
												]
											}),
											h("div", {
												style: { display: "flex", gap: "8px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" },
												children: [
													h("button", {
														type: "button",
														disabled: hudOffline || connecting,
														style: {
															flexShrink: 0,
															border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
															background: hudOffline || connecting ? "transparent" : "rgba(239, 68, 68, 0.14)",
															color: hudOffline || connecting ? "var(--dsw-alias-label-tertiary, #94a3b8)" : "#f87171",
															padding: "6px 12px",
															borderRadius: "8px",
															fontSize: "12.5px",
															fontWeight: "500",
															cursor: hudOffline || connecting ? "not-allowed" : "pointer",
															opacity: hudOffline || connecting ? 0.6 : 1
														},
														onClick: () => { void sendTestBubble("waiting_approval"); },
														children: "🔔 预览等待提醒"
													}),
													h("button", {
														type: "button",
														disabled: hudOffline || connecting,
														style: {
															flexShrink: 0,
															border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
															background: hudOffline || connecting ? "transparent" : "var(--dsw-alias-brand-primary, #3b82f6)",
															color: hudOffline || connecting ? "var(--dsw-alias-label-tertiary, #94a3b8)" : "#fff",
															padding: "6px 12px",
															borderRadius: "8px",
															fontSize: "12.5px",
															fontWeight: "500",
															cursor: hudOffline || connecting ? "not-allowed" : "pointer",
															opacity: hudOffline || connecting ? 0.6 : 1
														},
														onClick: () => { void sendTestBubble("preview"); },
														children: "🫧 发送测试气泡"
													})
												]
											})
										]
									}),

									connecting ? h("div", {
										style: {
											fontSize: "12.5px",
											color: "var(--dsw-alias-label-tertiary, #94a3b8)"
										},
										children: "正在连接桌面气泡窗口..."
									}) : null,

									hudOffline ? h("div", {
										style: {
											background: "rgba(245, 158, 11, 0.12)",
											border: "1px solid rgba(245, 158, 11, 0.35)",
											color: "var(--dsw-alias-label-primary)",
											borderRadius: "10px",
											padding: "12px 14px",
											fontSize: "12.5px",
											lineHeight: 1.6,
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											gap: "12px"
										},
										children: [
											h("div", {
												children: [
													h("div", { style: { fontWeight: "600", marginBottom: "4px" }, children: "⚠ 桌面气泡窗口未运行" }),
													h("div", { children: "气泡窗口默认在启动 3 秒后拉起；若长时间未就绪，请确认已安装 Electron（例如 ~/.dsh/electron），或用环境变量 DSH_HUD_ELECTRON 指定可执行文件路径后重启 DSH。" })
												]
											}),
											h("button", {
												type: "button",
												style: {
													flexShrink: 0,
													border: "1px solid rgba(245, 158, 11, 0.55)",
													background: "rgba(245, 158, 11, 0.18)",
													color: "var(--dsw-alias-label-primary)",
													padding: "5px 12px",
													borderRadius: "6px",
													fontSize: "12px",
													fontWeight: "600",
													cursor: "pointer"
												},
												onClick: () => {
													retryCountRef.current = 0;
													void connectHud();
												},
												children: "重试连接"
											})
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

											// 等待批准 / 填写方向常驻强提醒
											h("div", {
												style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
												children: [
													h("div", {
														children: [
															h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "等待批准 / 填写方向常驻强提醒" }),
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "需要你批准权限、审阅计划或填写执行方向时，置顶弹出高对比常驻提示并累计等待时间，防止后台挂起遗忘。默认开启。" })
														]
													}),
													h("input", {
														type: "checkbox",
														checked: cfg.showWaitingBubble !== false,
														style: { width: "18px", height: "18px", cursor: "pointer" },
														onChange: (e) => save({ showWaitingBubble: e.target.checked })
													})
												]
											}),

											h("div", { style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,0.08))" } }),

											// 等待操作时播放轻柔提示音
											h("div", {
												style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
												children: [
													h("div", {
														children: [
															h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "等待操作时播放轻柔提示音" }),
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "出现新的批准请求或提问需要你处理时，播放一声简短轻柔的提醒音。" })
														]
													}),
													h("input", {
														type: "checkbox",
														checked: Boolean(cfg.waitingSound),
														style: { width: "18px", height: "18px", cursor: "pointer" },
														onChange: (e) => save({ waitingSound: e.target.checked })
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
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "这么久没有任何进度事件，就自动收起常驻气泡（1 ~ 1440 分钟，默认 45）。" })
														]
													}),
													h("input", {
														type: "number",
														value: idleMinDraft,
														step: 5,
														min: 1,
														max: 1440,
														style: { width: "85px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
														onChange: (e) => {
															const raw = e.target.value;
															setIdleMinDraft(raw);
															if (raw.trim() === "") return;
															const n = Number(raw);
															if (Number.isFinite(n) && n >= 1 && n <= 1440) {
																save({ runningIdleTimeoutMin: Math.round(n) }, { debounceMs: 250 });
															}
														},
														onBlur: () => {
															const n = Number(idleMinDraft);
															const clamped = Number.isFinite(n) && idleMinDraft.trim() !== ""
																? Math.max(1, Math.min(1440, Math.round(n)))
																: (cfg.runningIdleTimeoutMin ?? 45);
															setIdleMinDraft(String(clamped));
															if (clamped !== cfg.runningIdleTimeoutMin) {
																save({ runningIdleTimeoutMin: clamped });
															}
														}
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
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "任务结束后完成提示在屏幕停留的时间（2000 ~ 60000ms，默认 8500ms）。" })
														]
													}),
													h("input", {
														type: "number",
														value: durationDraft,
														step: 500,
														min: 2000,
														max: 60000,
														style: { width: "85px", height: "28px", padding: "0 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: "13px" },
														onChange: (e) => {
															const raw = e.target.value;
															setDurationDraft(raw);
															if (raw.trim() === "") return;
															const n = Number(raw);
															if (Number.isFinite(n) && n >= 2000 && n <= 60000) {
																save({ duration: Math.round(n) }, { debounceMs: 250 });
															}
														},
														onBlur: () => {
															const n = Number(durationDraft);
															const clamped = Number.isFinite(n) && durationDraft.trim() !== ""
																? Math.max(2000, Math.min(60000, Math.round(n)))
																: (cfg.duration ?? 8500);
															setDurationDraft(String(clamped));
															if (clamped !== cfg.duration) {
																save({ duration: clamped });
															}
														}
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
																onChange: (e) => save({ bubbleOpacity: Number(e.target.value) }, { debounceMs: 120 })
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

											// 自定义图片上传（自动压缩至 128x128）
											h("div", {
												style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
												children: [
													h("div", {
														children: [
															h("div", { style: { fontSize: "13.5px", fontWeight: "500", color: "var(--dsw-alias-label-primary)" }, children: "上传自定义头像图片" }),
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "从电脑本地选择一张图片（PNG/JPG/WebP/GIF），自动居中裁剪压缩为 128×128。" })
														]
													}),
													h("div", {
														style: { display: "flex", gap: "8px", alignItems: "center" },
														children: [
															h("input", {
																type: "file",
																ref: fileInputRef,
																accept: "image/png,image/jpeg,image/webp,image/gif",
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
																onChange: (e) => save({ avatarType: "color", avatarColor: e.target.value }, { debounceMs: 120 })
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
																	setCfg((prev) => ({ ...prev, avatarColor: val }));
																	if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
																		save({ avatarType: "color", avatarColor: val }, { debounceMs: 180 });
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
															h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #94a3b8)" }, children: "支持常用字体，并自动检索系统已安装的字体。" })
														]
													}),
													h("select", {
														value: cfg.fontFamily || "system",
														style: {
															padding: "4px 8px",
															borderRadius: "6px",
															border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
															background: "var(--dsw-alias-bg-layer-1, #1e293b)",
															color: "var(--dsw-alias-label-primary)",
															colorScheme: "dark light",
															fontSize: "12.5px",
															maxWidth: "230px"
														},
														onChange: (e) => save({ fontFamily: e.target.value }),
														children: [
															h("optgroup", {
																label: "── 常用推荐字体 ──",
																style: optionStyle,
																children: PRESET_FONTS.map((f) => h("option", { key: f.id, value: f.id, style: optionStyle, children: f.name }))
															}),
															systemFonts.length > 0 ? h("optgroup", {
																label: `── 系统安装字体 (${systemFonts.length} 款) ──`,
																style: optionStyle,
																children: systemFonts.map((f) => h("option", { key: f, value: f, style: optionStyle, children: f }))
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
																onChange: (e) => save({ fontSize: Number(e.target.value) }, { debounceMs: 120 })
															}),
															h("span", { style: { fontSize: "13px", fontWeight: "600", width: "36px", textAlign: "right", color: "var(--dsw-alias-label-primary)" }, children: `${cfg.fontSize || 14}px` })
														]
													})
												]
											})
										]
									}),

									toast.text ? h("div", {
										style: { color: toast.isError ? "#f59e0b" : "#10b981", fontSize: "13px", fontWeight: "600", padding: "4px 0" },
										children: toast.text
									}) : null
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
