/* ==========================================================================
   全局状态 (Global State)
   ========================================================================== */
let globalConfig = {};
let currentCategory = "";
let currentMode = "csv";
let questionBank = [];
let currentQuestion = null;
let currentIndex = 0;
let userApiKey = localStorage.getItem("sf_api_key") || ""; // 启动时自动读取
let userModel = localStorage.getItem("sf_user_model") || "gemini-1.5-flash";
let memoryState = {
    isActive: false,
    queue: [],
    nextRoundQueue: [],
    round: 1,
    currentCard: null
};

let stats = { totalAnswered: 0, correctCount: 0, wrongCount: 0, sessionWrong: [] };
let longTermErrors = JSON.parse(localStorage.getItem("longTermErrors") || "[]");
let favorites = JSON.parse(localStorage.getItem("favorites") || "[]");
// ... 原有的全局变量 ...

// 🟢 新增：题目熟练度数据库 (存 localStorage)
// 结构: { "题目内容Hash": { level: 0, isVague: false, lastTime: timestamp } }
let questionStats = JSON.parse(localStorage.getItem("sf_question_stats") || "{}");

/* ==========================================================================
   [新增] 核心工具：替代原生弹窗 (Custom UI)
   ========================================================================== */

// 替代 alert：轻提示 (自动消失)
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast-msg ${type}`;
    // 简单加个图标
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
    el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    container.appendChild(el);

    // 2秒后消失
    setTimeout(() => {
        el.style.animation = "toastFadeOut 0.3s ease forwards";
        setTimeout(() => el.remove(), 300);
    }, 2000);
}

// 辅助：计算字符串 Hash 作为唯一ID (防止题目太长做Key)
// 🟢 修复版：增加了空值校验，防止报错
function getQHash(str) {
    // 1. 如果传进来的不是字符串，或者为空，直接返回一个默认ID
    if (!str || typeof str !== 'string') {
        return "q_" + Math.random().toString(36).substr(2);
    }

    let hash = 0, i, chr;
    if (str.length === 0) return hash;
    for (i = 0; i < str.length; i++) {
        chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return "q_" + hash;
}

// 辅助：保存状态
function saveQuestionStats() {
    localStorage.setItem("sf_question_stats", JSON.stringify(questionStats));
}

// 辅助：获取某题的状态
function getStat(q) {
    const id = getQHash(q);
    if (!questionStats[id]) {
        questionStats[id] = { level: 0, isVague: false, lastTime: 0 };
    }
    return questionStats[id];
}
// 替代 confirm：返回 Promise 的弹窗
function showConfirm(msg) {
    return new Promise((resolve) => {
        const modal = document.getElementById('sys-modal');
        const msgEl = document.getElementById('sys-modal-msg');
        const btnOk = document.getElementById('sys-btn-confirm');
        const btnCancel = document.getElementById('sys-btn-cancel');

        msgEl.innerText = msg;
        modal.style.display = 'flex'; // 显示弹窗

        // 临时点击事件处理
        const handleOk = () => {
            cleanup();
            resolve(true);
        };
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        // 绑定事件 (使用 once:true 防止重复绑定)
        btnOk.addEventListener('click', handleOk, { once: true });
        btnCancel.addEventListener('click', handleCancel, { once: true });

        // 支持回车和ESC
        const handleKey = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation();
                btnOk.click();
            }
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                btnCancel.click();
            }
        };
        document.addEventListener('keydown', handleKey);

        // 清理函数
        function cleanup() {
            modal.style.display = 'none';
            btnOk.removeEventListener('click', handleOk);
            btnCancel.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKey);
        }
    });
}

/* ==========================================================================
   初始化 (Initialization)
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const res = await fetch("data/config.json");
        if (!res.ok) throw new Error("Config load failed");
        globalConfig = await res.json();

        initCategorySelect();
        updateStatsUI();
        restoreMemorySession();

    } catch (e) {
        showToast("配置文件加载失败", "error");
        console.error(e);
    }
    setupEventListeners();
});

/* ==========================================================================
   状态保存与恢复
   ========================================================================== */
function saveMemorySession() {
    if (!memoryState.isActive) return;
    localStorage.setItem("memory_session", JSON.stringify(memoryState));
}

function clearMemorySession() {
    localStorage.removeItem("memory_session");
    memoryState.isActive = false;
    memoryState.currentCard = null;
}

async function restoreMemorySession() {
    const saved = localStorage.getItem("memory_session");
    if (!saved) return;

    try {
        const session = JSON.parse(saved);
        if (session.isActive && (session.queue.length > 0 || session.currentCard)) {
            // 🟢 替换 confirm
            const shouldContinue = await showConfirm(`检测到上次有未完成的背诵进度 (第 ${session.round} 轮，剩余 ${session.queue.length + 1} 题)。\n是否继续？`);

            if (shouldContinue) {
                memoryState = session;
                currentMode = "json";
                toggleView("memory");
                if (memoryState.currentCard) {
                    renderMemoryCard(memoryState.currentCard);
                } else {
                    loadNextMemoryCard();
                }
            } else {
                clearMemorySession();
            }
        }
    } catch (e) {
        console.error("存档损坏", e);
        clearMemorySession();
    }
}

/* ==========================================================================
   界面切换
   ========================================================================== */
function toggleView(viewName) {
    const csvView = document.getElementById("view-csv");
    const memView = document.getElementById("view-memory");

    if (viewName === "csv") {
        csvView.style.display = "block";
        memView.style.display = "none";
        document.getElementById("category-select").disabled = false;
    } else {
        csvView.style.display = "none";
        memView.style.display = "block";
        document.getElementById("category-select").disabled = true;
    }
}

function initCategorySelect() {
    const select = document.getElementById("category-select");
    select.innerHTML = "";
    Object.keys(globalConfig).forEach((key, idx) => {
        const op = document.createElement("option");
        op.value = key; op.innerText = key;
        select.appendChild(op);
        if (idx === 0) currentCategory = key;
    });

    updateUnitList();

    select.addEventListener("change", async (e) => {
        if (memoryState.isActive) {
            showToast("请先退出当前的背诵模式！", "error");
            e.target.value = currentCategory;
            return;
        }
        currentCategory = e.target.value;
        updateUnitList();
        resetCSVState();
    });
}

function updateUnitList() {
    const list = document.getElementById("unit-list");
    list.innerHTML = "";
    const units = globalConfig[currentCategory] || [];

    if (units.length > 0 && units[0].endsWith(".json")) {
        currentMode = "json";
    } else {
        currentMode = "csv";
    }

    toggleView("csv");

    units.forEach((u, i) => {
        const div = document.createElement("div");
        div.className = "unit-item";
        div.innerHTML = `<input type="checkbox" id="u${i}" value="${u}" class="unit-checkbox"><label for="u${i}">${u.replace(/\.(csv|json)$/, '')}</label>`;
        list.appendChild(div);
    });

    document.querySelectorAll(".unit-checkbox").forEach(cb => cb.addEventListener("change", loadSelectedUnits));
}

async function loadSelectedUnits() {
    if (memoryState.isActive) return;

    const cbs = document.querySelectorAll(".unit-checkbox:checked");
    const files = Array.from(cbs).map(c => c.value);

    if (files.length === 0) {
        resetCSVState();
        return;
    }

    questionBank = [];
    document.getElementById("q-unit").innerText = "Loading...";

    try {
        if (currentMode === "csv") {
            for (const f of files) {
                const text = await fetchFile(`data/${currentCategory}/${f}`);
                questionBank = questionBank.concat(parseCSV(text, f));
            }
            toggleView("csv");
            document.getElementById("btn-start-memory").style.display = "none";
            document.getElementById("input-full").style.display = "block";
            document.getElementById("btn-submit").style.display = "inline-block";
            startCSVQuiz();
        } else {
            for (const f of files) {
                const json = await fetchJSON(`data/${currentCategory}/${f}`);
                json.forEach(j => j.source = f);
                questionBank = questionBank.concat(json);
            }
            toggleView("csv");
            document.getElementById("q-main").innerText = `已加载 ${questionBank.length} 道问答题`;
            document.getElementById("q-sub").innerText = "准备好开始死磕了吗？点击下方红色按钮启动！";
            document.getElementById("input-full").style.display = "none";
            document.getElementById("btn-submit").style.display = "none";
            document.getElementById("btn-next").style.display = "none";
            document.getElementById("result-area").style.display = "none";

            const startBtn = document.getElementById("btn-start-memory");
            startBtn.style.display = "block";
            startBtn.innerText = `🚀 启动背诵粉碎机 (${questionBank.length}题)`;
        }
        document.getElementById("q-unit").innerText = `${files.length} 章 / ${questionBank.length} 题`;
    } catch (e) {
        console.error(e);
        showToast("加载失败，请检查文件", "error");
    }
}

/* ==========================================================================
   模式 A: CSV 填空逻辑
   ========================================================================== */
function resetCSVState() {
    questionBank = [];
    document.getElementById("q-main").innerText = "请选择章节...";
    document.getElementById("q-sub").innerText = "";
    document.getElementById("input-full").value = "";
    document.getElementById("input-full").style.display = "block";
    document.getElementById("btn-start-memory").style.display = "none";
    document.getElementById("result-area").style.display = "none";
}

function startCSVQuiz() {
    if (questionBank.length === 0) return;
    questionBank.sort(() => Math.random() - 0.5);
    currentIndex = 0;
    loadNextCSVQuestion();
}

function loadNextCSVQuestion() {
    if (currentIndex >= questionBank.length) {
        showToast("🎉 本轮填空练习结束！", "success");
        currentIndex = 0;
        questionBank.sort(() => Math.random() - 0.5);
    }
    currentQuestion = questionBank[currentIndex];
    document.getElementById("q-tag").innerText = currentQuestion.tag || "Q&A";
    document.getElementById("q-main").innerText = currentQuestion.question;
    document.getElementById("q-sub").innerText = "";
    document.getElementById("input-full").value = "";
    document.getElementById("input-full").focus();
    document.getElementById("result-area").style.display = "none";
    document.getElementById("info-area").style.display = "none";
    document.getElementById("btn-submit").style.display = "inline-block";
    document.getElementById("btn-next").style.display = "none";
    updateFavIcon();
}

function checkCSVAnswer() {
    const input = document.getElementById("input-full").value.trim();
    if (!input) return;
    const correct = currentQuestion.answer;
    const keywords = input.split(/\s+/);
    let isRight = true;
    keywords.forEach(k => { if (!correct.includes(k)) isRight = false; });

    const resArea = document.getElementById("result-area");
    resArea.style.display = "block";
    document.getElementById("info-area").style.display = "block";
    document.getElementById("info-content").innerHTML = correct;

    if (isRight) {
        resArea.className = "result correct"; resArea.innerText = "✅ 正确";
        stats.correctCount++;
    } else {
        resArea.className = "result wrong"; resArea.innerText = "❌ 错误";
        handleWrongAnswer(currentQuestion);
    }
    stats.totalAnswered++;
    updateStatsUI();
    document.getElementById("btn-submit").style.display = "none";
    document.getElementById("btn-next").style.display = "inline-block";
    document.getElementById("btn-next").focus();
}

function handleNextCSV() {
    currentIndex++;
    loadNextCSVQuestion();
}

/* ==========================================================================
   模式 B: 嵌入式背诵粉碎机
   ========================================================================== */
function startMemoryGrinder() {
    if (questionBank.length === 0) {
        showToast("请先在左侧选择章节加载题目！", "error");
        return;
    }

    // 🟢 智能抽题算法
    // 1. 先把题目分类
    let hard = [], vague = [], easy = [], newQ = [];

    questionBank.forEach(q => {
        if (!q || !q.question) return;
        const stat = getStat(q.question);
        // 强制加入历史错题 (如果在 longTermErrors 里)
        const isLongTermError = longTermErrors.some(err => err.question === q.question);

        if (isLongTermError || stat.level < 0) {
            hard.push(q); // 绝对痛点
        } else if (stat.level === 0) {
            newQ.push(q); // 新题
        } else if (stat.isVague || stat.level <= 2) {
            vague.push(q); // 模糊/半生不熟
        } else {
            easy.push(q); // 熟题 (Lv >= 3)
        }
    });

    // 2. 动态配比生成队列
    // 策略：优先塞满 Hard 和 Vague，剩下的位子给 New，最后留一点给 Easy 防遗忘
    let finalQueue = [];

    // (1) 错题/痛点：全要！
    finalQueue.push(...hard);

    // (2) 模糊题：全要！
    finalQueue.push(...vague);

    // (3) 新题：最多取 20 个 (防止一次学太多新崩溃)
    newQ.sort(() => Math.random() - 0.5);
    finalQueue.push(...newQ.slice(0, 20));

    // (4) 熟题：只取 10% 做抽查 (或者至少 5 题)
    easy.sort(() => Math.random() - 0.5);
    const easyCount = Math.max(5, Math.floor(easy.length * 0.1));
    finalQueue.push(...easy.slice(0, easyCount));

    // 如果选出来的太少（比如刚开始全是新题），那就多补点新题
    if (finalQueue.length < 10 && newQ.length > 20) {
        finalQueue.push(...newQ.slice(20, 30));
    }

    // 去重 (防止某些题既是错题又是新题)
    finalQueue = [...new Set(finalQueue)];

    // 打乱顺序
    finalQueue.sort(() => Math.random() - 0.5);

    if (finalQueue.length === 0) {
        showToast("没有符合条件的题目，已重置为全量复习", "info");
        finalQueue = [...questionBank];
        finalQueue.sort(() => Math.random() - 0.5);
    }

    // 初始化状态
    memoryState.isActive = true;
    memoryState.queue = finalQueue;
    memoryState.nextRoundQueue = [];
    memoryState.round = 1;
    memoryState.currentCard = null;

    toggleView("memory");

    // 显示本次复习的构成 (让用户心里有数)
    showToast(`智能生成计划：\n🔴攻坚:${hard.length} 🟡模糊:${vague.length} ⚪️新题:${Math.min(newQ.length, 20)} 🟢抽查:${Math.min(easy.length, easyCount)}`, "success");

    loadNextMemoryCard();
    saveMemorySession();
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
    const stat = getStat(card.q);

    // 🟢 视觉优化：显示熟练度等级
    let levelIcon = "🥚";
    if (stat.level < 0) levelIcon = "💀"; // 死穴
    else if (stat.level >= 1) levelIcon = "🐣";
    else if (stat.level >= 3) levelIcon = "🦅";
    else if (stat.level >= 5) levelIcon = "👑"; // 大师

    document.getElementById("memory-round-display").innerText = `Round ${memoryState.round} | Lv.${stat.level} ${levelIcon}`;
    document.getElementById("memory-remain").innerText = memoryState.queue.length + 1;
    document.getElementById("memory-q-text").innerHTML = card.q;
    document.getElementById("q-tag").innerText = stat.isVague ? "模糊点 🟡" : (stat.level < 0 ? "错题 🔴" : "MEMORY");

    const input = document.getElementById("memory-input");
    input.value = "";
    input.disabled = false;
    input.focus();

    document.getElementById("memory-answer-area").style.display = "none";
    document.getElementById("btn-reveal").style.display = "block";

    // 🟢 改造按钮组：增加“模糊”按钮
    const btnGroup = document.getElementById("btn-grade-group");
    btnGroup.style.display = "none";
    btnGroup.innerHTML = `
        <button onclick="rateMemory('wrong')" class="btn-grade wrong">❌ 没记住 (1)</button>
        <button onclick="rateMemory('vague')" class="btn-grade vague" style="background:#f59e0b;color:white">🤔 模糊 (2)</button>
        <button onclick="rateMemory('correct')" class="btn-grade correct">✅ 记住了 (Enter)</button>
    `;

    updateFavIcon();
}
// ==========================================
// 辅助：本地关键词高亮 (极速版)
// ==========================================
function highlightKeywords(userText, standardText) {
    // 简单的分词：提取标准答案里的中文名词或英文单词
    // 这里用简单粗暴的策略：按标点和空格切分，取长度>1的词
    const keywords = standardText.split(/[，。；：,.;:\s\(\)（）\n]+/)
        .filter(k => k.length >= 2 && !['什么', '怎么', '原理', '特点'].includes(k));

    let processedText = userText;
    let hitCount = 0;

    keywords.forEach(kw => {
        if (userText.includes(kw)) {
            // 给匹配到的词加绿色背景
            const reg = new RegExp(kw, 'g');
            processedText = processedText.replace(reg, `<span style="background:#bbf7d0; color:#14532d; padding:0 2px; border-radius:2px;">${kw}</span>`);
            hitCount++;
        }
    });

    return {
        html: processedText,
        hitRate: keywords.length > 0 ? (hitCount / keywords.length) : 0,
        missed: keywords.filter(k => !userText.includes(k)) // 找出没命中的词
    };
}
// ==========================================
// 核心逻辑：秒开奖 + 异步 AI (完形填空版)
// ==========================================
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

    // 1. 显示标准答案
    if (ansArea) ansArea.style.display = "block";
    if (answerTextEl) {
        answerTextEl.innerHTML = card.a;
        if (typeof renderMath === 'function') setTimeout(() => renderMath("memory-a-text"), 10);
    }

    // 切换按钮
    if (btnReveal) btnReveal.style.display = "none";
    if (btnGroup) btnGroup.style.display = "flex";
    if (inputEl) inputEl.disabled = true;

    // 2. AI 批改区域
    if (aiBox && aiContent) {
        aiBox.style.display = "block";
        aiContent.innerHTML = `<div style="color:#64748b;">⏳ AI 正在帮你补全答案...</div>`;

        if (inputVal.length > 0) {
            checkWithAI_Async(card.q, card.a, inputVal).then(aiResult => {
                if (!aiResult) return;

                let prettyHtml = aiResult.markup || inputVal;

                // 🟢 <ok>：语义正确 (哪怕词不一样) -> 绿色底
                prettyHtml = prettyHtml.replace(/<ok>(.*?)<\/ok>/g,
                    `<span style="color:#14532d; font-weight:bold; background:#dcfce7; border-bottom:2px solid #86efac; padding:0 2px; border-radius:2px;">$1</span>`);

                // 🔴 <bad>：事实错误 -> 红色删除线
                prettyHtml = prettyHtml.replace(/<bad>(.*?)<\/bad>/g,
                    `<del style="color:#ef4444; text-decoration-thickness: 2px; margin:0 2px;">$1</del>`);

                // 🟣 <fill>：完全遗漏的内容 -> 紫色胶囊样式 (带加号)
                prettyHtml = prettyHtml.replace(/<(fill|miss)>(.*?)<\/(fill|miss)>/g,
                    `<span style="color:#6d28d9; font-weight:bold; background:#f3e8ff; border:1px solid #d8b4fe; border-radius:4px; margin:0 3px; padding:0 4px; font-size:0.9em; vertical-align: middle;">✚ $2</span>`);
                aiContent.innerHTML = `
                    <div style="margin-bottom:8px; font-weight:bold; color:#334155;">🤖 批改结果：</div>
                    <div style="font-size:1.1em; line-height:1.8; background:#fff; padding:15px; border-radius:8px; border:1px solid #e2e8f0; font-family:sans-serif;">
                        ${prettyHtml}
                    </div>
                    <div style="margin-top:8px; font-size:0.9em; color:#64748b;">
                        💡 评语: ${aiResult.reason}
                    </div>
                `;

                // 渲染公式
                if (typeof renderMath === 'function') renderMath("ai-feedback-content");

            }).catch(err => {
                console.error(err);
                aiContent.innerHTML = "<span style='color:#cbd5e1'>AI 批改失败</span>";
            });
        } else {
            aiContent.innerHTML = "😶 空白卷";
        }
    }
}
// 核心逻辑
async function checkWithAI_Async(question, standardAnswer, userAnswer) {
    if (!userApiKey) {
        console.error("❌ 没有 API Key");
        return null;
    }

    // 1. 动态决定 URL
    let apiUrl = "";
    if (userModel && userModel.includes("gemini")) {
        apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        console.log("🚀 Google Gemini: ", userModel);
    } else {
        apiUrl = "https://api.siliconflow.cn/v1/chat/completions";
        console.log("🚀 硅基流动: ", userModel);
    }

    // 🟢 极速版 Prompt (去油腻，去评语)
    const prompt = `
    【指令】对用户回答进行"嵌入式"补全。
    
    【输入】
    题：${question}
    标：${standardAnswer}
    用：${userAnswer}

    【规则】
    1. <ok>：标记用户写对的词（锚点）。
    2. <fill>：在锚点**紧后方**插入遗漏的标准内容（定义/公式）。
    3. **禁止追加**：严禁在句尾堆砌，必须嵌入句中。
    4. **结构保留**：保留用户原话，仅做插入。

    【示例】
    标：g(.) 将预测值与真实标记联系。
    生：套个非线性的联系函数。
    输出：{"pass":true, "markup":"套个非线性的 <ok>联系函数</ok><fill>(作用: 将预测值与真实标记联系)</fill>。"}

    【输出JSON】
    {"pass": boolean, "markup": "string"}
    `;

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userApiKey}`
            },
            body: JSON.stringify({
                model: userModel,
                messages: [
                    { role: "system", content: "JSON only." },
                    { role: "user", content: prompt }
                ],
                // 温度设为 0，让模型不做发散思考，专注执行
                temperature: 0.05,
                max_tokens: 400
            })
        });

        if (!response.ok) return null;
        const data = await response.json();
        let content = data.choices[0].message.content;

        content = content.replace(/```json/gi, "").replace(/```/g, "").trim();
        content = content.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

        // 🟢 容错处理：如果 AI 没返回 reason，我们前端自己补一个空字符串，防止报错
        const result = JSON.parse(content);
        if (!result.reason) result.reason = "AI 已完成批改 (极速模式)";

        return result;

    } catch (e) {
        console.error(e);
        return null;
    }
}
// type: 'correct' | 'wrong' | 'vague'
function rateMemory(type) {
    const card = memoryState.currentCard;
    const stat = getStat(card.q);
    stat.lastTime = Date.now();

    if (type === 'correct') {
        // ✅ 记住了：熟练度+1，模糊标记清除
        stat.level++;
        stat.isVague = false;
        stats.correctCount++;
        showToast("熟练度 +1 🆙", "success");

        // 如果是从错题集里做对的，把错误记录消掉
        const errIdx = longTermErrors.findIndex(e => e.question === card.q);
        if (errIdx !== -1) {
            longTermErrors.splice(errIdx, 1);
            localStorage.setItem("longTermErrors", JSON.stringify(longTermErrors));
        }

    } else if (type === 'wrong') {
        // ❌ 没记住：熟练度归零（或扣分），强制进入下一轮
        stat.level = -1; // 变成负数表示“最近做错过”
        stat.isVague = false;

        memoryState.nextRoundQueue.push(card);
        handleWrongAnswer({
            question: card.q,
            answer: card.a,
            tag: "Memory",
            source: card.source || "JSON"
        });
        showToast("已加入错题循环 🔴", "error");

    } else if (type === 'vague') {
        // 🤔 模糊：熟练度不变（或微降），标记为模糊，进入下一轮
        stat.isVague = true;
        if (stat.level > 0) stat.level--; // 稍微降一点级

        memoryState.nextRoundQueue.push(card); // 模糊的也要再来一遍！
        showToast("标记为模糊，稍后重试 🟡", "info");
    }

    // 保存状态
    saveQuestionStats();

    stats.totalAnswered++;
    updateStatsUI();
    memoryState.currentCard = null;
    loadNextMemoryCard();
}

async function handleMemoryRoundEnd() {
    if (memoryState.nextRoundQueue.length === 0) {
        // 🟢 替换 alert -> confirm 模拟信息弹窗（只有一个确认逻辑）
        await showConfirm(`🎉 太棒了！本组题目已全部攻克！\n总耗时 ${memoryState.round} 轮。`);
        clearMemorySession();
        quitMemoryMode();
    } else {
        // 🟢 替换 confirm
        const keepGoing = await showConfirm(`第 ${memoryState.round} 轮结束。\n还有 ${memoryState.nextRoundQueue.length} 道硬骨头没啃下来。\n\n是否立即开始第 ${memoryState.round + 1} 轮死磕？`);

        if (keepGoing) {
            memoryState.queue = [...memoryState.nextRoundQueue];
            memoryState.nextRoundQueue = [];
            memoryState.round++;
            memoryState.queue.sort(() => Math.random() - 0.5);
            saveMemorySession();
            loadNextMemoryCard();
        } else {
            quitMemoryMode();
        }
    }
}

async function quitMemoryMode() {
    // 🟢 替换 confirm
    const exit = await showConfirm("确定要退出背诵模式吗？\n(您的进度已自动保存，下次进来可以继续)");
    if (exit) {
        toggleView("csv");
    }
}

/* ==========================================================================
   事件绑定与工具
   ========================================================================== */
function setupEventListeners() {
    // 侧边栏
    document.getElementById("sidebar-toggle").onclick = () => document.getElementById("sidebar").classList.add("active");
    document.querySelector(".sidebar-overlay").onclick = () => document.getElementById("sidebar").classList.remove("active");
    document.querySelector(".close-sidebar").onclick = () => document.getElementById("sidebar").classList.remove("active");
    document.getElementById("btn-select-all").onclick = () => {
        document.querySelectorAll(".unit-checkbox").forEach(cb => cb.checked = true);
        loadSelectedUnits();
    };
    document.getElementById("btn-clear-all").onclick = () => {
        document.querySelectorAll(".unit-checkbox").forEach(cb => cb.checked = false);
        loadSelectedUnits();
    };

    // CSV 交互
    document.getElementById("btn-submit").onclick = checkCSVAnswer;
    document.getElementById("btn-next").onclick = handleNextCSV;
    document.getElementById("input-full").addEventListener("keyup", e => {
        if (e.key === "Enter") document.getElementById("btn-submit").style.display !== "none" ? checkCSVAnswer() : handleNextCSV();
    });

    document.getElementById("btn-start-memory").onclick = startMemoryGrinder;

    // 🟢 快捷键逻辑：背诵输入
    document.getElementById("memory-input").addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.keyCode === 13)) {
            const btnReveal = document.getElementById("btn-reveal");
            if (btnReveal && btnReveal.style.display !== "none") {
                e.preventDefault(); e.stopPropagation();
                revealMemoryAnswer();
            }
        }
    });

    // 🟢 快捷键逻辑：判分
    // ...
    // 🟢 快捷键逻辑：判分
    document.addEventListener("keydown", (e) => {
        const memView = document.getElementById("view-memory");
        const gradeGrp = document.getElementById("btn-grade-group");
        const sysModal = document.getElementById("sys-modal");

        if (memView.style.display !== "none" &&
            gradeGrp.style.display !== "none" && // 注意这里改成不为 none 即可
            sysModal.style.display === "none") {

            if (e.key === "1") { e.preventDefault(); rateMemory('wrong'); }
            if (e.key === "2") { e.preventDefault(); rateMemory('vague'); } // 新增按键 2
            if (e.key === "3" || e.key === "Enter") {
                if (!e.ctrlKey) { e.preventDefault(); rateMemory('correct'); }
            }
        }
    });
    // ...

    document.getElementById("btn-fav").onclick = toggleFav;
    document.getElementById("wrong-count").onclick = retryWrong;
}

// === Helpers ===
async function fetchFile(url) { const res = await fetch(url); return new TextDecoder("utf-8").decode(await res.arrayBuffer()); }
async function fetchJSON(url) { const res = await fetch(url); if (!res.ok) throw new Error(res.status); return await res.json(); }
function parseCSV(text, src) {
    return text.split(/\r?\n/)
        .filter(l => l.trim() && !l.includes("正面"))
        .map(l => {
            const p = l.split(";");
            return p.length >= 2 ? {
                question: p[0].replace(/"/g, ''),
                answer: p[1].replace(/"/g, ''),
                tag: p[2] ? p[2].replace(/"/g, '') : "Def",
                source: src
            } : null
        }).filter(x => x);
}
function extractKeywords(html) {
    const r = /<b>(.*?)<\/b>/g;
    const k = []; let m;
    while (m = r.exec(html)) k.push(m[1].replace(/[.,:;，。：；]/g, "").trim());
    return k;
}

// === 错题/收藏 ===
function handleWrongAnswer(q) {
    stats.wrongCount++; stats.sessionWrong.push(q);
    const idx = longTermErrors.findIndex(x => x.question === q.question);
    if (idx !== -1) {
        longTermErrors[idx].count++;
        longTermErrors[idx].lastDate = new Date().toLocaleString();
    } else {
        q.count = 1;
        q.lastDate = new Date().toLocaleString();
        longTermErrors.push(q);
    }
    localStorage.setItem("longTermErrors", JSON.stringify(longTermErrors));
    updateStatsUI();
}

function toggleFav() {
    let t = null;
    const csvView = document.getElementById("view-csv");
    if (csvView.style.display !== "none") t = currentQuestion;
    else if (memoryState.currentCard) t = { question: memoryState.currentCard.q, answer: memoryState.currentCard.a, tag: "Memory", source: "JSON" };

    if (!t) return;
    const i = favorites.findIndex(x => x.question === t.question);
    if (i !== -1) favorites.splice(i, 1);
    else favorites.push(t);
    localStorage.setItem("favorites", JSON.stringify(favorites));
    updateFavIcon();
    showToast(i !== -1 ? "已取消收藏" : "已收藏", "info");
}

function updateFavIcon() {
    let t = null;
    const csvView = document.getElementById("view-csv");
    if (csvView.style.display !== "none") t = currentQuestion;
    else t = memoryState.currentCard ? { question: memoryState.currentCard.q } : null;

    const btn = document.getElementById("btn-fav");
    if (t && favorites.some(x => x.question === t.question)) {
        btn.style.color = "#fbbf24"; btn.innerText = "★";
    } else {
        btn.style.color = "#cbd5e1"; btn.innerText = "☆";
    }
}

function updateStatsUI() {
    document.getElementById("score-val").innerText = stats.correctCount + "/" + stats.totalAnswered;
    const w = document.getElementById("wrong-count");
    w.innerText = `❌ ${stats.wrongCount} (点击重测)`;
    w.style.color = stats.sessionWrong.length > 0 ? "#ef4444" : "#64748b";
}

async function retryWrong() {
    if (stats.sessionWrong.length === 0) { showToast("本次无错题", "info"); return; }

    // 🟢 替换 confirm
    const doRetry = await showConfirm(`确认重测本次的 ${stats.sessionWrong.length} 道错题吗？`);
    if (doRetry) {
        questionBank = [...stats.sessionWrong];
        stats.sessionWrong = [];
        stats.wrongCount = 0;
        currentMode = "csv";
        toggleView("csv");
        startCSVQuiz();
    }
}
// ==========================================
// 设置与 API Key 管理
// ==========================================
// ==========================================
// 设置与 API Key 管理 (Toast 优化版)
// ==========================================
// ==========================================
// ⚙️ 设置与模型管理 (升级版)
// ==========================================

window.openSettingsModal = function () {
    const modal = document.getElementById("settings-modal");
    const input = document.getElementById("api-key-input");
    const status = document.getElementById("api-key-status");
    const modelSelect = document.getElementById("model-select"); // 获取下拉框

    if (!modal || !input) return;
    modal.style.display = "flex";

    // 1. 回显 API Key 状态
    if (userApiKey) {
        input.value = userApiKey;
        if (status) {
            status.style.display = "block";
            status.innerHTML = "<span style='color:#16a34a'>✅ 当前已配置 Key</span>";
        }
    } else {
        input.value = "";
        if (status) status.style.display = "none";
    }

    // 2. 🟢 回显当前选择的模型
    if (modelSelect) {
        modelSelect.value = userModel; // 自动选中上次存的模型
    }
};

window.saveApiKey = function () {
    const input = document.getElementById("api-key-input");
    const modelSelect = document.getElementById("model-select");

    let val = input.value.trim();

    // 1. 获取当前选中的模型
    // 如果还没加载出来下拉框，默认它是硅基流动
    const selectedModel = modelSelect ? modelSelect.value : "Qwen/Qwen2.5-7B-Instruct";

    // 2. 基础非空校验
    if (!val) {
        showToast("Key 不能为空", "error");
        return;
    }

    // 🟢 3. 智能格式校验 (核心修复点)
    if (selectedModel.includes("gemini")) {
        // --- Google Gemini 模式 ---
        // Google 的 Key 通常以 AIza 开头
        if (!val.startsWith("AIza")) {
            showToast("Google Key 通常以 AIza 开头，请检查复制是否完整", "info");
            // 这里我们只提示，不return，防止万一Google改规则了导致没法保存
        }
    } else {
        // --- 硅基流动 (SiliconFlow) 模式 ---
        // SiliconFlow 的 Key 必须以 sk- 开头
        if (!val.startsWith("sk-")) {
            showToast("硅基流动 Key 必须以 sk- 开头", "error");
            return; // 硅基流动的格式很死，不对直接拦截
        }
    }

    // 4. 更新变量并保存
    userApiKey = val;
    userModel = selectedModel;

    localStorage.setItem("sf_api_key", userApiKey);
    localStorage.setItem("sf_user_model", userModel);

    // 5. 界面反馈
    // 这一步很重要，让用户确认自己切到了哪个厂商
    const providerName = selectedModel.includes("gemini") ? "Google Gemini" : "硅基流动";
    showToast(`保存成功！已切换至: ${providerName}`, "success");

    closeSettingsModal();
};

function closeSettingsModal() {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "none";
}

function saveApiKey() {
    const input = document.getElementById("api-key-input");
    const val = input.value.trim();

    // 🟢 改动点：空值检查用 Toast
    if (!val) {
        showToast("Key 不能为空", "error");
        return;
    }

    // 🟢 改动点：格式警告用 Toast，且不阻止保存 (万一以后格式变了呢)
    if (!val.startsWith("sk-")) {
        showToast("格式提示：Key 通常以 sk- 开头", "info");
    }

    userApiKey = val;
    localStorage.setItem("sf_api_key", userApiKey);

    // 🟢 改动点：保存成功用 Toast，而不是 alert
    showToast("API Key 保存成功！", "success");
    closeSettingsModal();
}

// === 历史错题/导出 (功能保持，但加上 🟢 替换) ===
window.exportGlobalData = function () {
    const data = { favorites, longTermErrors, timestamp: new Date().toISOString() };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    showToast("备份导出成功", "success");
};

window.importGlobalData = function (input) {
    const f = input.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = e => {
        try {
            const d = JSON.parse(e.target.result);
            if (d.favorites) favorites = d.favorites;
            if (d.longTermErrors) longTermErrors = d.longTermErrors;
            localStorage.setItem("favorites", JSON.stringify(favorites));
            localStorage.setItem("longTermErrors", JSON.stringify(longTermErrors));
            showToast("导入成功", "success");
        } catch (err) { showToast("格式错误", "error"); }
    };
    r.readAsText(f);
};

// 🟢 替换清空历史错题
window.clearLongTermErrors = async () => {
    if (await showConfirm("确定清空所有历史错题记录吗？")) {
        longTermErrors = [];
        localStorage.setItem("longTermErrors", "[]");
        reviewLongTermErrors();
        showToast("记录已清空", "success");
    }
};

// 🟢 替换重置进度
window.clearData = async () => {
    if (await showConfirm("确定重置本次会话进度？(不影响收藏和历史)")) {
        stats = { totalAnswered: 0, correctCount: 0, wrongCount: 0, sessionWrong: [] };
        updateStatsUI();
        showToast("会话已重置", "success");
    }
};

// 保留辅助函数
window.reviewLongTermErrors = function () {
    const m = document.getElementById("error-modal"); m.style.display = "block";
    const l = document.getElementById("error-list-container"); l.innerHTML = "";
    longTermErrors.sort((a, b) => b.count - a.count).forEach(e => {
        const d = document.createElement("div"); d.style = "border-bottom:1px solid #eee;padding:10px;";
        d.innerHTML = `<div style="font-weight:bold;color:#ef4444">❌ ${e.count}次</div><div>${e.question}</div><div style="color:#666;font-size:0.9em">${e.answer}</div>`;
        l.appendChild(d);
    });
};
window.closeErrorModal = () => document.getElementById("error-modal").style.display = "none";
window.startLongTermReviewMode = () => { if (longTermErrors.length) { questionBank = [...longTermErrors]; closeErrorModal(); toggleView("csv"); startCSVQuiz(); } };
window.reviewSessionErrors = retryWrong;
window.showErrorAnalysis = () => showToast(`历史错题: ${longTermErrors.length} / 收藏: ${favorites.length}`, "info");

document.getElementById("btn-view-fav").onclick = () => {
    if (!favorites.length) { showToast("收藏夹为空", "info"); return; }
    questionBank = [...favorites]; toggleView("csv"); startCSVQuiz(); document.getElementById("sidebar").classList.remove("active");
};
// ==========================================
// 🩹 最终修复补丁 (追加到 script.js 末尾)
// ==========================================

// 1. 修复 toggleKeyVisibility 报错 (找回丢失的小眼睛功能)
window.toggleKeyVisibility = function () {
    const input = document.getElementById("api-key-input");
    if (input) {
        input.type = input.type === "password" ? "text" : "password";
    }
};

// 2. 修复设置弹窗逻辑
window.openSettingsModal = function () {
    const modal = document.getElementById("settings-modal");
    const input = document.getElementById("api-key-input");
    const status = document.getElementById("api-key-status");

    if (!modal || !input) return;
    modal.style.display = "flex";

    // 读取并显示当前的 Key
    if (userApiKey) {
        input.value = userApiKey;
        if (status) {
            status.style.display = "block";
            status.innerHTML = "<span style='color:#16a34a'>✅ 当前已配置 Key</span>";
        }
    } else {
        input.value = "";
        if (status) status.style.display = "none";
    }
};

window.closeSettingsModal = function () {
    const modal = document.getElementById("settings-modal");
    if (modal) modal.style.display = "none";
};

