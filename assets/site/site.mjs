// Illustrative local state only: this page never connects to the HCC runtime.
const navigation = document.querySelector("#navigation");
const menu = document.querySelector(".menu-toggle");
function closeMenu({ focus = false } = {}) {
  navigation.classList.remove("is-open");
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-label", "打开导航");
  if (focus) menu.focus();
}
menu.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  navigation.classList.toggle("is-open", open);
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
});
navigation.addEventListener("click", (event) => {
  if (event.target.closest("a")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true")
    closeMenu({ focus: true });
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".site-header")) closeMenu();
});
window.matchMedia("(min-width: 641px)").addEventListener("change", (event) => {
  if (event.matches) closeMenu();
});

const panel = document.querySelector("#demo-panel");
const tabs = [...document.querySelectorAll("[data-view]")];
const views = {
  agents: panel.innerHTML,
  tasks: `<div class="panel-heading"><div><span class="small-label">SHARED TASKS</span><h3>谁在做什么，一目了然。</h3></div><span class="status-chip">协作示例</span></div>
    <div class="task-table"><div class="task-row"><span class="task-icon complete">✓</span><div><strong>实现登录模块</strong><small>负责人 · Claude</small></div><span class="status-chip">已完成</span></div><div class="task-row"><span class="task-icon ongoing"></span><div><strong>验证登录流程</strong><small>负责人 · Codex</small></div><span class="status-chip">进行中</span></div><div class="task-row"><span class="task-icon waiting"></span><div><strong>审查权限边界</strong><small>待分配 · DeepSeek Harness</small></div><span class="status-chip">待处理</span></div></div>
    <div class="demo-event"><span class="tiny-check" aria-hidden="true">✓</span> 认领任务、更新状态，让分工保持清晰。</div><p class="panel-bottom">任务状态保存在项目总线中，供同一项目内的 Agent 查询。</p>`,
  handoffs: `<div class="panel-heading"><div><span class="small-label">PROJECT HANDOFFS</span><h3>把工作交出去，把上下文留下。</h3></div><span class="status-chip">协作示例</span></div>
    <dl class="handoff-detail"><dt>变更摘要 · Claude</dt><dd>登录模块实现完成，待验证权限边界。</dd><dt>验证方式</dt><dd><code>npm test</code> · 结果写入交接记录</dd><dt>下一步 · Codex</dt><dd>检查登录流程、错误处理及未授权访问。</dd></dl><p class="panel-bottom">把摘要、测试和风险显式交接，让下一位 Agent 有据可查。</p>`,
};
function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  panel.innerHTML = views[tab.dataset.view];
  panel.setAttribute("aria-labelledby", tab.id);
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next], true);
  });
}

const toast = document.querySelector("#copy-status");
let toastTimer;
function announce(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      announce("命令已复制，可以粘贴到终端。");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      announce("无法自动复制，已选中命令，请手动复制。");
    }
  });
}

const dialog = document.querySelector("#screenshot-dialog");
document
  .querySelector("#open-screenshot")
  .addEventListener("click", () => dialog.showModal());
document
  .querySelector("#close-screenshot")
  .addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    dialog.close();
});
