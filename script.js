/* ==========================================================================
   1. 全局配置与状态 (Global State)
   ========================================================================== */
let globalConfig = {};
let currentCategory = "QA";
let questionBank = [];
let userApiKey = localStorage.getItem("sf_api_key") || "";
let userModel = localStorage.getItem("sf_user_model") || "Qwen/Qwen2.5-14B-Instruct";

// 核心背诵状态
let memoryState = {
    isActive: false,
    queue: [],
    nextRoundQueue: [],
    round: 1,
    currentCard: null
};

// 熟练度系统
let questionStats = JSON.parse(localStorage.getItem("sf_question_stats") || "{}");
// 错题本 (长期)
let longTermErrors = JSON.parse(localStorage.getItem("longTermErrors") || "[]");
// 收藏
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");

let sessionStats = { total: 0, correct: 0, wrong: 0 };
let selectedFiles = [];

/* ==========================================================================
   2. 核心工具函数 (Utils)
   ========================================================================== */

function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast-msg ${type}`;
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
    el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    container.appendChild(el);

    setTimeout(() => {
        el.style.animation = "toastFadeOut 0.3s ease forwards";
        setTimeout(() => el.remove(), 300);
    }, 2000);
}

function showConfirm(msg) {
    return new Promise((resolve) => {
        const modal = document.getElementById('sys-modal');
        if (!modal) { resolve(confirm(msg)); return; }

        const msgEl = document.getElementById('sys-modal-msg');
        const btnOk = document.getElementById('sys-btn-confirm');
        const btnCancel = document.getElementById('sys-btn-cancel');

        msgEl.innerText = msg;
        modal.style.display = 'flex';

        const cleanup = () => {
            modal.style.display = 'none';
            btnOk.removeEventListener('click', handleOk);
            btnCancel.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKey);
        };

        const handleOk = () => { cleanup(); resolve(true); };
        const handleCancel = () => { cleanup(); resolve(false); };

        const handleKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); btnOk.click(); }
            if (e.key === 'Escape') { e.preventDefault(); btnCancel.click(); }
        };

        btnOk.addEventListener('click', handleOk, { once: true });
        btnCancel.addEventListener('click', handleCancel, { once: true });
        document.addEventListener('keydown', handleKey);
    });
}

function getQHash(str) {
    if (!str || typeof str !== 'string') return "q_" + Math.random().toString(36).substr(2);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return "q_" + hash;
}

function getStat(q) {
    const id = getQHash(q);
    if (!questionStats[id]) {
        questionStats[id] = { level: 0, isVague: false, lastTime: 0 };
    }
    return questionStats[id];
}

function saveQuestionStats() {
    localStorage.setItem("sf_question_stats", JSON.stringify(questionStats));
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

function renderMath(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (window.MathJax && window.MathJax.typesetPromise) {
        window.MathJax.typesetPromise([el]).catch(err => console.log(err));
    }
}

/* ==========================================================================
   3. 初始化 (Init) - 强力调试版
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
    // 1. 打印当前环境信息，方便排查路径
    console.log("当前页面路径:", window.location.href);

    try {
        const configUrl = "data/config.json";
        console.log(`准备请求: ${configUrl}`);

        const res = await fetch(configUrl);

        // 🟢 显影关键点 1: 检查 HTTP 状态码
        console.log(`请求状态: ${res.status} ${res.statusText}`);

        if (res.ok) {
            const rawConfig = await res.json();
            console.log("Config 内容:", rawConfig); // 看看是不是空的

            // 🟢 智能识别配置格式
            if (Array.isArray(rawConfig)) {
                globalConfig = { "默认题库": rawConfig };
                globalConfig._isFlat = true;
            } else {
                globalConfig = rawConfig;
                globalConfig._isFlat = false;
            }

            initCategorySelect();
        } else {
            // 🔴 显影关键点 2: 如果 404 了，在这里报错
            console.error("加载失败，状态码:", res.status);
            showToast(`配置加载失败 (HTTP ${res.status})`, "error");

            // 在列表里直接显示错误信息，防止 Toast 消失看不见
            const list = document.getElementById("unit-list");
            if (list) {
                list.innerHTML = `
                    <div style="padding:20px; color:#ef4444; background:#fef2f2; border:1px solid #fecaca; border-radius:8px;">
                        <strong>⚠️ 无法加载配置文件</strong><br>
                        1. 请求地址: <code>${new URL(configUrl, window.location.href).href}</code><br>
                        2. 状态码: <b>${res.status}</b> (通常是 404)<br>
                        3. 请检查GitHub仓库里 <b>data</b> 文件夹和 <b>config.json</b> 是否全是小写！
                    </div>
                `;
            }
        }
    } catch (e) {
        console.error("代码炸了:", e);
        showToast("发生系统错误: " + e.message, "error");
    }

    setupEventListeners();
    updateLobbyUI();
});

/* ==========================================================================
   4. 界面与大厅逻辑 (Lobby)
   ========================================================================== */

function toggleView(viewName) {
    const welcomeView = document.getElementById("view-welcome");
    const memoryView = document.getElementById("view-memory");
    const sidebar = document.getElementById("sidebar");

    if (viewName === "memory") {
        welcomeView.style.display = "none";
        memoryView.style.display = "block";
        if (sidebar) sidebar.classList.remove("active");
    } else {
        welcomeView.style.display = "flex";
        memoryView.style.display = "none";
        updateLobbyUI(); // 每次回大厅都刷新UI
    }
}

function updateLobbyUI() {
    // 🟢 1. 检查 API Key
    const warningBanner = document.getElementById("api-warning-banner");
    if (warningBanner) {
        if (!userApiKey) {
            warningBanner.style.display = "flex";
        } else {
            warningBanner.style.display = "none";
        }
    }

    // 2. 检查存档
    const saved = localStorage.getItem("memory_session");
    const btnContinue = document.getElementById("btn-continue");
    const infoContinue = document.getElementById("continue-info");

    if (saved) {
        try {
            const sess = JSON.parse(saved);
            if (sess.isActive && (sess.queue.length > 0 || sess.currentCard)) {
                btnContinue.style.display = "flex";
                infoContinue.innerText = `Round ${sess.round} | 剩余 ${sess.queue.length + 1} 题`;
            } else {
                btnContinue.style.display = "none";
            }
        } catch (e) { btnContinue.style.display = "none"; }
    } else {
        btnContinue.style.display = "none";
    }

    // 3. 检查错题本
    const btnMistakes = document.getElementById("btn-mistakes");
    const infoMistakes = document.getElementById("mistake-info");
    const count = longTermErrors.length;

    if (count > 0) {
        infoMistakes.innerText = `累计 ${count} 道痛点`;
        btnMistakes.style.opacity = "1";
        btnMistakes.disabled = false;
    } else {
        infoMistakes.innerText = "暂无错题";
        btnMistakes.style.opacity = "0.6";
        btnMistakes.disabled = true;
    }
}

// 继续进度
window.continueSession = function () {
    restoreMemorySession();
};

function initCategorySelect() {
    const keys = Object.keys(globalConfig);
    if (keys.length > 0) {
        updateUnitList();
    }
}

function updateUnitList() {
    const list = document.getElementById("unit-list");
    if (!list) return;
    list.innerHTML = "";

    const units = globalConfig[currentCategory] || [];
    // 兼容：如果不以 .json 结尾，也当作是题目文件
    const jsonUnits = units.filter(u => typeof u === 'string');

    if (jsonUnits.length === 0) {
        list.innerHTML = `<div style="padding:10px; color:#94a3b8;">此分类下没有文件</div>`;
        return;
    }

    // 🟢 章节名称映射表 (你的个性化配置)
    const chapterMap = {
        "1": "第一章：概念学习",
        "2": "第二章：线性模型",
        "3": "第三章：决策树",
        "4": "第四章：神经网络",
        "5": "第五章：贝叶斯学习",
        "6": "第六章：聚类算法",
        "7": "第七章：强化学习",
        "8": "第八章：算法评估",
        "9": "第九章：搜索算法",
        "10": "第十章：实时、增量、知识搜索",
        "11": "第十一章：大模型 I <智能体>",  // 罗马数字 I
        "12": "第十二章：对抗搜索",
        "13": "第十三章：大模型 II <基础>",   // 罗马数字 II
        "14": "第十四章：大模型 III <推理>",  // 罗马数字 III
        "16": "第十六章：大模型 IV <多模态>", // 罗马数字 IV
        "add": "补充题"
    };

    jsonUnits.forEach((u, i) => {
        const div = document.createElement("div");
        div.className = "unit-item";

        // 点击整个条目都能触发勾选
        div.onclick = (e) => {
            // 防止点击 checkbox 本身时触发两次
            if (e.target.type !== 'checkbox') {
                const cb = document.getElementById(`u${i}`);
                cb.checked = !cb.checked;
                updateSelectionStats();
            }
        };

        // 🟢 获取显示名称
        // 假设你的文件名是 "1.json", "2.json" 等
        const fileKey = u.replace(".json", "");
        // 如果映射表里有这个 key，就用映射的名字，否则显示原文件名
        const displayName = chapterMap[fileKey] || fileKey;

        div.innerHTML = `
            <input type="checkbox" id="u${i}" value="${u}" class="unit-checkbox">
            <label for="u${i}" style="pointer-events:none;">${displayName}</label>
        `;
        list.appendChild(div);
    });
}

function updateSelectionStats() {
    const cbs = document.querySelectorAll(".unit-checkbox:checked");
    selectedFiles = Array.from(cbs).map(c => c.value);
    document.getElementById("selection-stats").innerText = `已选 ${selectedFiles.length} 章`;

    const btnLaunch = document.getElementById("btn-launch");
    if (btnLaunch) {
        btnLaunch.disabled = selectedFiles.length === 0;
        btnLaunch.innerText = selectedFiles.length > 0 ? `🚀 启动 (${selectedFiles.length}章)` : "请先选择章节";
        btnLaunch.style.opacity = selectedFiles.length > 0 ? "1" : "0.5";
    }
}

// 启动新复习 (章节选择)
async function launchReview() {
    if (selectedFiles.length === 0) return;

    // 如果有旧存档，提示会覆盖
    if (localStorage.getItem("memory_session")) {
        const overwrite = await showConfirm("开启新复习将覆盖当前的【继续游戏】进度。\n确定要重新开始吗？");
        if (!overwrite) return;
    }

    showToast("正在装填弹药...", "info");
    let newBank = [];
    try {
        for (const f of selectedFiles) {
            const json = await fetchJSON(`data/${currentCategory}/${f}`);
            json.forEach(j => j.source = f.replace(".json", ""));
            newBank = newBank.concat(json);
        }
        startMemoryGrinder(newBank);
        // 收起侧边栏
        document.getElementById("sidebar").classList.remove("active");
    } catch (e) {
        showToast("题库加载失败: " + e.message, "error");
    }
}

/* ==========================================================================
   5. 智能背诵引擎 (Engine)
   ========================================================================== */

// isRetryMode: 是否为错题本/收藏夹模式 (不生成新题)
function startMemoryGrinder(sourceBank, isRetryMode = false) {
    if (!sourceBank || sourceBank.length === 0) {
        showToast("没有题目！", "error");
        return;
    }

    let finalQueue = [];

    if (isRetryMode) {
        // 错题本模式：直接用传进来的队列
        finalQueue = [...sourceBank];
    } else {
        // 算法模式
        let hard = [], vague = [], easy = [], newQ = [];
        sourceBank.forEach(q => {
            if (!q || !q.question) return;
            const stat = getStat(q.question);
            const isLongTermError = longTermErrors.some(err => err.question === q.question);

            if (isLongTermError || stat.level < 0) hard.push(q);
            else if (stat.level === 0) newQ.push(q);
            else if (stat.isVague || stat.level <= 2) vague.push(q);
            else easy.push(q);
        });

        finalQueue.push(...hard);
        finalQueue.push(...vague);

        newQ.sort(() => Math.random() - 0.5);
        finalQueue.push(...newQ.slice(0, 20)); // 每次最多20新题

        easy.sort(() => Math.random() - 0.5);
        finalQueue.push(...easy.slice(0, Math.max(5, Math.floor(easy.length * 0.1))));

        if (finalQueue.length < 10 && newQ.length > 20) {
            finalQueue.push(...newQ.slice(20, 30));
        }
        finalQueue = [...new Set(finalQueue)];
        if (finalQueue.length === 0) finalQueue = [...sourceBank];

        // 普通模式下打乱
        finalQueue.sort(() => Math.random() - 0.5);
        showToast(`计划生成：\n🔴攻坚:${hard.length} 🟡模糊:${vague.length} ⚪️新:${Math.min(newQ.length, 20)}`, "success");
    }

    // 初始化背诵状态
    memoryState.isActive = true;
    memoryState.queue = finalQueue;
    memoryState.nextRoundQueue = [];
    memoryState.round = 1;
    memoryState.currentCard = null;
    sessionStats = { total: 0, correct: 0, wrong: 0 };

    toggleView("memory");
    loadNextMemoryCard();
    saveMemorySession(); // 立即存档
}

function loadNextMemoryCard() {
    if (memoryState.queue.length === 0) {
        handleMemoryRoundEnd();
        return;
    }
    memoryState.currentCard = memoryState.queue.pop();
    saveMemorySession();
    renderMemoryCard(memoryState.currentCard);
}

function renderMemoryCard(card) {
    const stat = getStat(card.question || card.q);

    let levelIcon = "🥚";
    if (stat.level < 0) levelIcon = "💀";
    else if (stat.level >= 1) levelIcon = "🐣";
    else if (stat.level >= 3) levelIcon = "🦅";
    else if (stat.level >= 5) levelIcon = "👑";

    const roundDisplay = document.getElementById("memory-round-display");
    if (roundDisplay) roundDisplay.innerText = `R${memoryState.round} | Lv.${stat.level} ${levelIcon}`;

    document.getElementById("memory-remain").innerText = memoryState.queue.length + 1;
    document.getElementById("memory-q-text").innerHTML = card.question || card.q;

    const tagEl = document.getElementById("q-tag");
    // 如果是错题本模式，显示错误次数
    if (longTermErrors.some(e => e.question === (card.question || card.q))) {
        const errCount = longTermErrors.find(e => e.question === (card.question || card.q)).count;
        tagEl.innerText = `错误 ${errCount} 次 🔴`;
        tagEl.className = "badge badge-danger";
        tagEl.style.background = "#fee2e2";
        tagEl.style.color = "#991b1b";
    } else {
        tagEl.innerText = stat.isVague ? "模糊 🟡" : "Review";
        tagEl.className = stat.isVague ? "badge vague-tag" : "badge tag-badge";
    }

    const input = document.getElementById("memory-input");
    input.value = "";
    input.disabled = false;
    input.focus();

    document.getElementById("memory-answer-area").style.display = "none";
    document.getElementById("ai-feedback-box").style.display = "none";
    document.getElementById("btn-reveal").style.display = "block";
    document.getElementById("btn-grade-group").style.display = "none";

    updateFavIcon();
}

function rateMemory(type) {
    if (!memoryState.currentCard) return;

    const card = memoryState.currentCard;
    const qText = card.question || card.q;
    const stat = getStat(qText);
    stat.lastTime = Date.now();

    if (type === 'correct') {
        stat.level++;
        stat.isVague = false;
        sessionStats.correct++;
        showToast("熟练度 +1 🆙", "success");

        // 🟢 做对了就从错题本里移除？用户说必须留着。
        // 现在的逻辑：如果做对了，暂不移除，或者减少错误权重？
        // 用户原话：“长期错题本必须留着”。
        // 所以我们只 update questionStats，不动 longTermErrors，除非用户手动删，或者我们设定一个阈值
        // 为了体验，我们可以让它在"错题本模式"下，做对了就暂时从"本轮"移除，但 longTermErrors 列表保留。

        // 如果想自动移除：
        // const errIdx = longTermErrors.findIndex(e => e.question === qText);
        // if (errIdx !== -1) { ... }
        // 既然用户说"必须留着"，那就不删。用户可以在错题本模式里手动点"斩杀"。

    } else if (type === 'wrong') {
        stat.level = -1;
        stat.isVague = false;
        sessionStats.wrong++;
        memoryState.nextRoundQueue.push(card);
        handleLongTermError(card); // 更新错误计数
        showToast("加入错题循环 🔴", "error");
    } else if (type === 'vague') {
        stat.isVague = true;
        if (stat.level > 0) stat.level--;
        memoryState.nextRoundQueue.push(card);
        showToast("标记为模糊 🟡", "info");
    }

    saveQuestionStats();
    sessionStats.total++;
    memoryState.currentCard = null;
    loadNextMemoryCard();
}

// 更新错题本数据
function handleLongTermError(q) {
    const qText = q.question || q.q;
    const aText = q.answer || q.a;
    const idx = longTermErrors.findIndex(e => e.question === qText);

    if (idx !== -1) {
        longTermErrors[idx].count = (longTermErrors[idx].count || 1) + 1;
        longTermErrors[idx].lastDate = new Date().toLocaleString();
    } else {
        longTermErrors.push({
            question: qText,
            answer: aText,
            count: 1,
            lastDate: new Date().toLocaleString(),
            source: q.source || "Review"
        });
    }
    localStorage.setItem("longTermErrors", JSON.stringify(longTermErrors));
}

// 🟢 启动错题本复习 (按错误率倒序)
window.startReviewWrong = function () {
    if (longTermErrors.length === 0) {
        showToast("暂无错题记录，太强了！", "success");
        return;
    }

    // 按错误次数倒序排列
    const sortedErrors = [...longTermErrors].sort((a, b) => b.count - a.count);

    // 启动 (true 表示 retryMode，不混入新题)
    startMemoryGrinder(sortedErrors, true);
    showToast(`已加载 ${sortedErrors.length} 道错题，按错误率排序`, "success");
};

async function handleMemoryRoundEnd() {
    if (memoryState.nextRoundQueue.length === 0) {
        await showConfirm(`🎉 本轮复习完成！\n所有题目已攻克。`);
        // 结束后，清空当前session，回到大厅
        localStorage.removeItem("memory_session");
        memoryState.isActive = false;
        toggleView("welcome");
    } else {
        const keepGoing = await showConfirm(`Round ${memoryState.round} 结束。\n还有 ${memoryState.nextRoundQueue.length} 道题没过。\n\n是否继续下一轮？`);
        if (keepGoing) {
            memoryState.queue = [...memoryState.nextRoundQueue];
            memoryState.nextRoundQueue = [];
            memoryState.round++;
            memoryState.queue.sort(() => Math.random() - 0.5);
            saveMemorySession();
            loadNextMemoryCard();
        } else {
            // 用户选择“否”，此时保留进度，直接回大厅
            toggleView("welcome");
        }
    }
}

// 🟢 退出按钮逻辑：只保存，不删除
async function quitMemoryMode() {
    // 自动保存
    saveMemorySession();
    showToast("进度已保存", "success");
    toggleView("welcome");
}

function saveMemorySession() {
    if (!memoryState.isActive) return;
    localStorage.setItem("memory_session", JSON.stringify(memoryState));
}

function restoreMemorySession() {
    const saved = localStorage.getItem("memory_session");
    if (!saved) return;
    try {
        const session = JSON.parse(saved);
        if (session.isActive) {
            memoryState = session;
            toggleView("memory");
            if (memoryState.currentCard) renderMemoryCard(memoryState.currentCard);
            else loadNextMemoryCard();
        }
    } catch (e) { localStorage.removeItem("memory_session"); }
}

/* ==========================================================================
   6. AI 判题逻辑 (v5.0 - 列表宽容版)
   ========================================================================== */
async function revealMemoryAnswer() {
    const inputEl = document.getElementById("memory-input");
    const ansArea = document.getElementById("memory-answer-area");
    const answerTextEl = document.getElementById("memory-a-text");
    const aiBox = document.getElementById("ai-feedback-box");
    const aiContent = document.getElementById("ai-feedback-content");
    const btnReveal = document.getElementById("btn-reveal");
    const btnGroup = document.getElementById("btn-grade-group");

    const inputVal = inputEl ? inputEl.value.trim() : "";
    const card = memoryState.currentCard;
    if (!card) return;

    ansArea.style.display = "block";
    answerTextEl.innerHTML = card.answer || card.a;
    setTimeout(() => renderMath("memory-a-text"), 50);

    btnReveal.style.display = "none";
    btnGroup.style.display = "flex";
    inputEl.disabled = true;

    aiBox.style.display = "block";
    aiContent.innerHTML = `<div style="color:#64748b;">⏳ AI 正在阅卷...</div>`;

    if (inputVal.length > 0) {
        checkWithAI_Async(card.question || card.q, card.answer || card.a, inputVal).then(aiResult => {
            if (!aiResult) {
                aiContent.innerHTML = "<span style='color:#cbd5e1'>API 请求失败</span>";
                return;
            }

            let prettyHtml = aiResult.markup || inputVal;
            prettyHtml = prettyHtml.replace(/\\\\([a-zA-Z]+)/g, "\\$1");
            prettyHtml = prettyHtml.replace(/\\\\([{}])/g, "\\$1");

            prettyHtml = prettyHtml.replace(/<ok>(.*?)<\/ok>/g,
                `<span style="color:#14532d; font-weight:bold; background:#dcfce7; border-bottom:2px solid #86efac; padding:0 2px; border-radius:2px;">$1</span>`);
            prettyHtml = prettyHtml.replace(/<bad>(.*?)<\/bad>/g,
                `<del style="color:#ef4444; text-decoration-thickness: 2px; margin:0 2px;">$1</del>`);
            prettyHtml = prettyHtml.replace(/<(fill|miss)>(.*?)<\/(fill|miss)>/g,
                `<span style="color:#6d28d9; font-weight:bold; background:#f3e8ff; border:1px solid #d8b4fe; border-radius:4px; margin:0 3px; padding:0 4px; font-size:0.9em; vertical-align: middle;">✚ $2</span>`);

            aiContent.innerHTML = `
                <div style="margin-bottom:8px; font-weight:bold; color:#334155;">🤖 批改结果：</div>
                <div style="font-size:1.1em; line-height:1.6; background:#fff; padding:15px; border-radius:8px; border:1px solid #e2e8f0;">${prettyHtml}</div>
                <div style="margin-top:8px; font-size:0.9em; color:#64748b;">💡 ${aiResult.reason}</div>
            `;
            setTimeout(() => renderMath("ai-feedback-content"), 50);
        });
    } else {
        aiContent.innerHTML = "😶 空白卷";
    }
}
/**
 * AI 判题逻辑 v4.2 (最终封箱版)
 * 特性：
 * 1. 智能去重：识别"大于"等于">"，不再重复补充公式。
 * 2. 智能熔断：胡说八道直接判错。
 * 3. 极速响应：基于 Qwen-14B。
 */
async function checkWithAI_Async(question, standardAnswer, userAnswer) {
    if (!userApiKey) {
        showToast("请先配置 API Key", "error");
        return null;
    }

    const targetModel = "Qwen/Qwen2.5-14B-Instruct";
    const apiUrl = "https://api.siliconflow.cn/v1/chat/completions";

    // 🟢 v5.2 Prompt: 强制 AI 进行“逐词清算”
    const prompt = `
    你是一个精准的阅卷助手。对比[标准答案]和[用户回答]。

    【核心原则：颗粒度判分】
    不要一刀切！请对用户回答中的**每个词**单独判断：
    1. **命中 (<ok>)**：意思准确或接近（如同义词 "操作"≈"行动"、"观察"≈"感知"），必须标绿！
    2. **错误 (<bad>)**：完全不对的概念（如"反馈"），必须用删除线划掉！
    3. **遗漏 (<fill>)**：标准答案有但用户没写的，在最后补充。

    【重要：只要有一个词是对的，就必须 pass:true！】

    【输出 JSON 规则】
    - 情况 A (混合): 对了一部分，错了一部分。
      JSON: {"pass":true, "markup":"<ok>大脑</ok>、<bad>反馈</bad>、<ok>操作</ok><fill>(缺: 感知)</fill>"}
    - 情况 B (全对): 
      JSON: {"pass":true, "markup":"<ok>大脑</ok>、<ok>感知</ok>、<ok>行动</ok>"}
    - 情况 C (全错/胡扯): 
      JSON: {"pass":false, "markup":"<bad>用户原话</bad><br/>💡 标: ..."}

    【示例教学 (你的痛点)】
    标: 1.大脑 2.感知 3.行动
    用: 大脑，操作，反馈
    ✅ 正确: {"pass":true, "markup":"<ok>大脑</ok>、<ok>操作</ok><fill>(即行动)</fill>、<bad>反馈</bad><fill>(感知)</fill>"}
    ❌ 错误: {"pass":false, "markup":"<bad>大脑，操作，反馈</bad>..."} (严禁把对的"大脑"也划掉！)

    【当前任务】
    题: ${question}
    标: ${standardAnswer}
    用: ${userAnswer}

    请输出标准 JSON。
    `;

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userApiKey}`
            },
            body: JSON.stringify({
                model: targetModel,
                messages: [
                    { role: "system", content: "Output concise JSON." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 512
            })
        });

        if (!response.ok) return null;

        const data = await response.json();
        let content = data.choices[0].message.content;

        // ============================================================
        // 🛡️ 终极 JSON 洗地机 (专治 LaTeX 和 换行符)
        // ============================================================

        // 1. 剥离 Markdown 标记
        content = content.replace(/```json|```/gi, "").trim();

        // 2. 🚑 核心修复：处理 LaTeX 反斜杠灾难
        // 逻辑：JSON 里的 \ 必须写成 \\。
        // 如果我们遇到一个 \，且它后面跟的不是 JSON 规定的转义符 (" \ / b f n r t u)，
        // 那它肯定就是 LaTeX 公式里的 \ (比如 \alpha)，我们要手动帮它加个 \
        content = content.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

        // 3. 🚑 核心修复：杀掉所有换行符
        // JSON 字符串里绝对不能有真正的换行（回车），否则必挂。
        // 我们把所有换行符都变成空格，反正 HTML 会自动折行。
        content = content.replace(/[\r\n]+/g, " ");
        content = content.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

        try {
            const result = JSON.parse(content);
            if (!result.reason) result.reason = result.pass ? "✅ 回答精准" : "💡 建议复习标准答案";
            return result;
        } catch (e) {
            console.warn("JSON修复:", content);
            return {
                pass: true,
                markup: userAnswer,
                reason: "AI 格式解析跳过"
            };
        }

    } catch (e) {
        console.error(e);
        return null;
    }
}

/* ==========================================================================
   7. 设置与收藏 (Features)
   ========================================================================== */
function toggleFav() {
    if (!memoryState.currentCard) return;
    const card = memoryState.currentCard;
    const qText = card.question || card.q;
    const idx = favorites.findIndex(x => x.question === qText);

    if (idx !== -1) { favorites.splice(idx, 1); showToast("已取消收藏", "info"); }
    else { favorites.push({ question: qText, answer: card.answer || card.a, source: card.source }); showToast("已收藏 ★", "success"); }

    localStorage.setItem("favorites", JSON.stringify(favorites));
    updateFavIcon();
}

function updateFavIcon() {
    const btn = document.getElementById("btn-fav");
    if (!btn || !memoryState.currentCard) return;
    const qText = memoryState.currentCard.question || memoryState.currentCard.q;
    const isFav = favorites.some(x => x.question === qText);
    btn.innerText = isFav ? "★" : "☆";
    btn.style.color = isFav ? "#fbbf24" : "#cbd5e1";
}

function openSettingsModal() {
    const modal = document.getElementById("settings-modal");
    const input = document.getElementById("api-key-input");
    const modelSelect = document.getElementById("model-select");
    if (!modal || !input) return;

    modal.style.display = "flex";
    input.value = userApiKey || "";
    if (modelSelect) modelSelect.value = userModel;

    const status = document.getElementById("api-key-status");
    if (status) status.style.display = userApiKey ? "block" : "none";
}

function saveApiKey() {
    const input = document.getElementById("api-key-input");
    const val = input.value.trim();
    const modelSelect = document.getElementById("model-select");

    if (!val) { showToast("Key 不能为空", "error"); return; }
    if (!val.startsWith("sk-")) showToast("提示: 硅基流动 Key 通常以 sk- 开头", "info");

    userApiKey = val;
    userModel = modelSelect ? modelSelect.value : "Qwen/Qwen2.5-14B-Instruct";
    localStorage.setItem("sf_api_key", userApiKey);
    localStorage.setItem("sf_user_model", userModel);

    showToast("保存成功", "success");
    closeSettingsModal();
}

function closeSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "none";
}

function toggleKeyVisibility() {
    const input = document.getElementById("api-key-input");
    if (input) input.type = input.type === "password" ? "text" : "password";
}

/* ==========================================================================
   8. 事件绑定 (Event Listeners)
   ========================================================================== */
function setupEventListeners() {
    const toggleBtn = document.getElementById("sidebar-toggle");
    if (toggleBtn) toggleBtn.onclick = () => document.getElementById("sidebar").classList.add("active");

    const closeBtns = document.querySelectorAll(".close-sidebar, .sidebar-overlay");
    closeBtns.forEach(btn => btn.onclick = () => document.getElementById("sidebar").classList.remove("active"));

    const unitList = document.getElementById("unit-list");
    if (unitList) {
        unitList.addEventListener("change", (e) => {
            if (e.target.classList.contains("unit-checkbox")) updateSelectionStats();
        });
    }

    const selAll = document.getElementById("btn-select-all");
    if (selAll) selAll.onclick = () => {
        document.querySelectorAll(".unit-checkbox").forEach(cb => cb.checked = true);
        updateSelectionStats();
    };

    const clrAll = document.getElementById("btn-clear-all");
    if (clrAll) clrAll.onclick = () => {
        document.querySelectorAll(".unit-checkbox").forEach(cb => cb.checked = false);
        updateSelectionStats();
    };

    const btnLaunch = document.getElementById("btn-launch");
    if (btnLaunch) btnLaunch.onclick = launchReview;

    const btnReveal = document.getElementById("btn-reveal");
    if (btnReveal) btnReveal.onclick = revealMemoryAnswer;

    const btnFav = document.getElementById("btn-fav");
    if (btnFav) btnFav.onclick = toggleFav;

    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.keyCode === 13)) {
            const btn = document.getElementById("btn-reveal");
            if (btn && btn.style.display !== "none") {
                e.preventDefault();
                revealMemoryAnswer();
            }
            return;
        }
        const gradeGrp = document.getElementById("btn-grade-group");
        if (gradeGrp && gradeGrp.style.display !== "none") {
            if (e.key === "1") { e.preventDefault(); rateMemory('wrong'); }
            if (e.key === "2") { e.preventDefault(); rateMemory('vague'); }
            if (e.key === "3" || e.key === "Enter") {
                e.preventDefault(); rateMemory('correct');
            }
        }
    });
}

/* ==========================================================================
   9. 暴露全局函数
   ========================================================================== */
/* ==========================================================================
10. 数据备份与恢复 (Data Backup)
========================================================================== */

// 📤 导出数据
window.exportData = function () {
    const data = {
        version: "1.0",
        date: new Date().toLocaleString(),
        stats: localStorage.getItem("sf_question_stats"), // 熟练度
        errors: localStorage.getItem("longTermErrors"),   // 错题本
        favorites: localStorage.getItem("favorites"),     // 收藏夹
        apiKey: localStorage.getItem("sf_api_key"),       // Key (可选)
        model: localStorage.getItem("sf_user_model")      // 模型设置
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `ZJUCSE_Review_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("备份已下载 📥", "success");
};

// 📥 导入数据
window.importData = function (input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            const data = JSON.parse(e.target.result);

            // 简单校验
            if (!data.stats && !data.errors) {
                throw new Error("文件格式不对");
            }

            const confirmImport = await showConfirm(`检测到备份文件 (${data.date})。\n导入将【覆盖】当前的错题本和熟练度。\n确定要导入吗？`);

            if (confirmImport) {
                if (data.stats) localStorage.setItem("sf_question_stats", data.stats);
                if (data.errors) localStorage.setItem("longTermErrors", data.errors);
                if (data.favorites) localStorage.setItem("favorites", data.favorites);
                if (data.apiKey) localStorage.setItem("sf_api_key", data.apiKey);
                if (data.model) localStorage.setItem("sf_user_model", data.model);

                showToast("数据恢复成功！正在刷新...", "success");
                setTimeout(() => location.reload(), 1000);
            }
        } catch (err) {
            showToast("导入失败: " + err.message, "error");
        }
        // 清空 input 防止重复触发
        input.value = "";
    };
    reader.readAsText(file);
};
/* ==========================================================================
   11. 错题本列表管理 (Mistake List Logic)
   ========================================================================== */

// 🟢 改写：现在的入口改为“打开弹窗”
window.startReviewWrong = function () {
    if (longTermErrors.length === 0) {
        showToast("暂无错题记录，太强了！", "success");
        return;
    }
    openMistakeModal();
};

function openMistakeModal() {
    const modal = document.getElementById("mistake-modal");
    const list = document.getElementById("mistake-list");
    const statsText = document.getElementById("mistake-stats-text");

    if (!modal || !list) return;

    // 按错误次数倒序排列
    const sortedErrors = [...longTermErrors].sort((a, b) => b.count - a.count);

    list.innerHTML = "";
    statsText.innerText = `共 ${sortedErrors.length} 道错题`;

    sortedErrors.forEach((err, index) => {
        const div = document.createElement("div");
        div.className = "mistake-item";

        // 颜色逻辑：3次以上为高危(high)，否则为低危(low)
        const riskClass = err.count >= 3 ? "high" : "low";
        const riskLabel = err.count >= 3 ? "🔥 高频" : "⚠️ 需注意";

        // 点击整行触发勾选
        div.onclick = (e) => {
            if (e.target.type !== 'checkbox') {
                const cb = document.getElementById(`mis-${index}`);
                cb.checked = !cb.checked;
            }
        };

        div.innerHTML = `
            <input type="checkbox" id="mis-${index}" class="mistake-checkbox" value="${err.question}" checked>
            <div class="mistake-content">
                <div class="mistake-q">${err.question}</div>
                <div class="mistake-meta">
                    <span class="error-badge ${riskClass}">错误 ${err.count} 次</span>
                    <span>• ${err.source || "未知来源"}</span>
                    <span>• 上次: ${err.lastDate.split(' ')[0] || "-"}</span>
                </div>
            </div>
        `;
        list.appendChild(div);
    });

    modal.style.display = "flex";
}

window.closeMistakeModal = function () {
    document.getElementById("mistake-modal").style.display = "none";
};

// 全选/清空
window.toggleSelectMistakes = function (selectAll) {
    document.querySelectorAll(".mistake-checkbox").forEach(cb => cb.checked = selectAll);
};

// ⚔️ 启动复习 (只复习勾选的)
window.launchMistakeReview = function () {
    const checked = document.querySelectorAll(".mistake-checkbox:checked");
    if (checked.length === 0) {
        showToast("请至少选择一道题", "info");
        return;
    }

    const selectedQTexts = Array.from(checked).map(cb => cb.value);

    // 从 longTermErrors 里找出对应的完整题目对象
    const targetQuestions = longTermErrors.filter(err => selectedQTexts.includes(err.question));

    // 关闭弹窗
    closeMistakeModal();
    // 收起侧边栏（以防万一）
    document.getElementById("sidebar").classList.remove("active");

    // 启动引擎
    startMemoryGrinder(targetQuestions, true);
    showToast(`开始复习 ${targetQuestions.length} 道错题`, "success");
};

// 🗑️ 移除选中的错题 (斩杀)
window.deleteSelectedMistakes = async function () {
    const checked = document.querySelectorAll(".mistake-checkbox:checked");
    if (checked.length === 0) return;

    const confirmDel = await showConfirm(`确定要将这 ${checked.length} 道题移出错题本吗？\n(熟练度不会受到影响)`);
    if (!confirmDel) return;

    const selectedQTexts = Array.from(checked).map(cb => cb.value);

    // 过滤掉选中的
    longTermErrors = longTermErrors.filter(err => !selectedQTexts.includes(err.question));
    localStorage.setItem("longTermErrors", JSON.stringify(longTermErrors));

    showToast(`已移除 ${checked.length} 道题`, "success");

    // 刷新列表
    if (longTermErrors.length === 0) {
        closeMistakeModal();
        updateLobbyUI(); // 刷新大厅计数
    } else {
        openMistakeModal(); // 重新渲染列表
    }
};
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.saveApiKey = saveApiKey;
window.toggleKeyVisibility = toggleKeyVisibility;
window.quitMemoryMode = quitMemoryMode;
window.revealMemoryAnswer = revealMemoryAnswer;
window.rateMemory = rateMemory;
window.continueSession = continueSession;
window.startReviewWrong = startReviewWrong;