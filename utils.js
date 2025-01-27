const dayjs = require("dayjs");
const { setTimeout: originalSetTimeout } = require("timers/promises"); // Node.js 内置
const { performance } = require("perf_hooks"); // Node.js 内置

function log(...args) {
  const time = dayjs().format("YYYY-MM-DD HH:mm:ss.SSS");
  console.log(`[${time}]`, ...args);
}

// 车站名到电报码的映射（需定期更新或调用官方接口动态获取）
const stationCodeMap = {
  北京: "BJP",
  上海: "SHH",
  昆山: "KSH",
  苏州: "SZH",
  灌南: "GIU",
  苏州园区: "KAH",
  张家港: "ZAU",
  // 其他车站...
};

// 反向映射：电报码 -> 中文
const codeToNameMap = Object.entries(stationCodeMap).reduce(
  (acc, [name, code]) => {
    acc[code] = name;
    return acc;
  },
  {}
);

const getStationCode = (str) => stationCodeMap[str] || "";

const getStationName = (code) => codeToNameMap[code] || "";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------
// 工具函数
// --------------------------
// 生成随机 User-Agent
function generateRandomUA() {
  const browsers = [
    {
      name: "Chrome",
      versions: ["117.0.0.0", "116.0.0.0"],
      platforms: ["Windows NT 10.0", "Macintosh"],
    },
    {
      name: "Firefox",
      versions: ["118.0", "117.0"],
      platforms: ["Windows NT 10.0"],
    },
  ];
  const randomBrowser = browsers[Math.floor(Math.random() * browsers.length)];
  return `Mozilla/5.0 (${randomBrowser.platforms[0]}) AppleWebKit/537.36 (KHTML, like Gecko) ${randomBrowser.name}/${randomBrowser.versions[0]} Safari/537.36`;
}

// Cookie 更新逻辑
function updateCookie(oldCookie, newCookies) {
  const cookieMap = new Map();
  // 解析旧 Cookie
  oldCookie.split(";").forEach((pair) => {
    const [key, value] = pair.trim().split("=");
    if (key) cookieMap.set(key, value);
  });
  // 合并新 Cookie
  newCookies.forEach((pair) => {
    const [key, value] = pair.split("=");
    if (key) cookieMap.set(key, value.split(";")[0]);
  });
  // 序列化
  return Array.from(cookieMap)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function getRandomInt(min = 1, max = 99) {
  min = Math.ceil(min); // 向上取整
  max = Math.floor(max); // 向下取整
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 加入优先级机制，筛选出优先级最高的车次，这样提交订单成功率更高
 */
function selectTargetTrain(trains, config) {
  // 确定需要检查的座位类型属性
  const seatProp = config.seatType === "O" ? "second" : "first";

  // 处理每个车次，添加优先级和是否配置车次标识
  const processedTrains = trains.map((train) => {
    const seatStatus = train.seatTypes[seatProp];

    // 计算优先级 '有'是最高级，数字次之，'无'最低
    let priority;
    if (seatStatus === "有") {
      priority = 3;
    } else if (seatStatus === "无") {
      priority = 1;
    } else {
      const num = Number(seatStatus);
      priority = !isNaN(num) && num >= 0 ? 2 : 1;
    }

    // 是否配置车次
    const isConfigTrain = train.trainNumber === config.trainNumber;

    return {
      ...train,
      priority,
      isConfigTrain,
      randomFactor: getRandomInt(), // 新增随机因子
    };
  });

  // 排序规则（三要素排序）
  processedTrains.sort((a, b) => {
    // 第一优先级：座位状态
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    // 第二优先级：是否配置车次
    if (b.isConfigTrain !== a.isConfigTrain) {
      return (b.isConfigTrain ? 1 : 0) - (a.isConfigTrain ? 1 : 0);
    }

    // 第三优先级：随机因子（打乱相同条件车次的顺序）
    return b.randomFactor - a.randomFactor;
  });

  return {
    processedTrains, // 返回所有处理后的车次
    targetTrain: processedTrains[0] || null, // 返回优先级最高的车次（即使所有车次都是"无"）
  };
}

/**
 * 增强数据清洗逻辑
 */
function sanitizeJsObject(jsObjectStr) {
  // 1. 移除注释（单行、多行）
  let sanitized = jsObjectStr
    .replace(/\/\/.*?\n/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // 2. 修复键名引号问题（兼容无引号、单引号、双引号）
  sanitized = sanitized
    // 处理无引号键名（如 key: value → "key": value）
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    // 统一单引号为双引号（如 'key': 'value' → "key": "value"）
    .replace(/'([^']+)'(?=\s*:)/g, '"$1"')
    .replace(/'/g, '"');

  // 3. 处理尾部逗号（数组和对象）
  sanitized = sanitized
    .replace(/,(\s*[}\]])/g, "$1") // 对象或数组尾部逗号
    .replace(/(\w+)\s*:\s*,/g, "$1: null,"); // 空值处理

  // 4. 转义字符串中的特殊字符（如双引号）
  // sanitized = sanitized
  //   .replace(/\\"/g, '\\\\"') // 已转义的双引号
  //   .replace(/([^\\])"/g, '$1\\"'); // 未转义的双引号

  // 5. 修复 Unicode 转义字符（如 \u5C45 → 正确保留）
  sanitized = sanitized.replace(/\\u([a-fA-F0-9]{4})/g, (match, group) =>
    String.fromCharCode(parseInt(group, 16))
  );

  // 6. 处理多行字符串（如 value: "..." 跨行）
  sanitized = sanitized.replace(
    /:\s*"((?:\\"|[^"])*?)"/g,
    (match, content) => `: "${content.replace(/\n/g, "\\n")}"`
  );

  // ---------------
  // 精准替换单引号（仅处理键和值的外层单引号）
  // ---------------
  sanitized = sanitized
    // 替换键名单引号: 'key' → "key"
    .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3')
    // 替换字符串值单引号: 'value' → "value"（排除包含转义单引号的情况）
    .replace(
      /(:\s*)'(?:(\\')|[^'])*?'/g,
      (match, p1) =>
        p1 + '"' + match.slice(p1.length + 1, -1).replace(/"/g, '\\"') + '"'
    );

  try {
    return JSON.parse(sanitized);
  } catch (error) {
    console.error("清洗后内容：", sanitized);
    throw new Error(`JSON 解析失败: ${error.message}`);
  }
}

/**
 * 从 HTML 中提取关键 Token
 * @param {string} html - 接口返回的原始 HTML 字符串
 * @returns {Object} { globalRepeatSubmitToken, keyCheckIsChange }
 */
function extractTokensFromHtml(html) {
  // 定义正则表达式匹配模式（兼容不同格式）
  const patterns = {
    globalRepeatSubmitToken: [
      // 匹配 JavaScript 变量形式
      /var\s+globalRepeatSubmitToken\s*=\s*['"]([a-zA-Z0-9]+)['"]/i,
      // 匹配隐藏表单域形式
      /<input[^>]+name="globalRepeatSubmitToken"[^>]+value="([^"]+)"/i,
    ],
    ticketInfoForPassengerForm: [
      // 匹配更完整的对象（兼容换行、嵌套、注释）
      /var\s+ticketInfoForPassengerForm\s*=\s*({[\s\S]*?})(?=\s*;|\s*<\/script>)/i,
    ],
  };

  // 提取 globalRepeatSubmitToken
  const token = patterns.globalRepeatSubmitToken
    .map((regex) => html.match(regex)?.[1])
    .find(Boolean);

  // 提取 ticketInfoForPassengerForm 对象
  const ticketInfoMatch = patterns.ticketInfoForPassengerForm
    .map((regex) => {
      const match = html.match(regex);
      return match ? match[1].trim() : null;
    })
    .find(Boolean);

  if (!ticketInfoMatch) {
    throw new Error("ticketInfoForPassengerForm 对象未找到");
  }

  // 处理特殊换行和缩进
  const normalized = ticketInfoMatch
    .replace(/\n\s*/g, " ") // 合并多行为单行
    .replace(/,\s*}/g, "}") // 修复对象尾部逗号
    .replace(/,\s*]/g, "]"); // 修复数组尾部逗号

  // 尝试解析为 JSON 对象
  let ticketInfo;
  try {
    ticketInfo = sanitizeJsObject(normalized);
  } catch (error) {
    throw new Error(`ticketInfoForPassengerForm 解析失败: ${error.message}`);
  }
  // 验证结果
  const errors = [];
  if (!token) errors.push("globalRepeatSubmitToken");
  if (errors.length > 0) {
    throw new Error(`提取失败: ${errors.join(", ")} 未找到`);
  }

  return {
    globalRepeatSubmitToken: token,
    ticketInfoForPassengerForm: ticketInfo,
  };
}

async function precisionTimer(targetTime) {
  // 使用高精度时间源
  const target = new Date(targetTime).getTime();
  let lastCheck = performance.now();
  let remaining = target - (performance.timeOrigin + performance.now());

  // 异常处理：目标时间已过时
  if (remaining <= 0) {
    throw new Error("Target time must be in the future");
  }

  // 第一阶段：粗粒度等待（误差±50ms）
  await originalSetTimeout(remaining - 50);

  // 第二阶段：精确微调（误差±1ms）
  while (true) {
    const now = performance.timeOrigin + performance.now();
    remaining = target - now;

    if (remaining <= 0) {
      return; // 到达目标时间
    }

    // 动态选择等待策略
    if (remaining > 10) {
      // 使用 setImmediate 释放事件循环
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      // 最后10ms进入忙等待（占用CPU）
      const start = performance.now();
      while (performance.now() - start < remaining) {
        // 空循环（Node.js进程需要独占CPU核心）
      }
      return;
    }
  }
}

const getPassengerStr = (config, passengers) => {
  return {
    passengerTicketStr: passengers
      .map(
        (passengerInfo) =>
          `${config.seatType},0,1,${passengerInfo.passenger_name},1,${passengerInfo.passenger_id_no},${passengerInfo.mobile_no},N,${passengerInfo.allEncStr}`
      )
      .join("_"),
    oldPassengerStr:
      passengers
        .map(
          (passengerInfo) =>
            `${passengerInfo.passenger_name},1,${passengerInfo.passenger_id_no},1`
        )
        .join("_") + "_",
    afterNatePassengerInfo:
      passengers
        .map(
          (passengerInfo) =>
            `${passengerInfo.passenger_type}#${passengerInfo.passenger_name}#${passengerInfo.passenger_id_type_code}#${passengerInfo.passenger_id_no}#${passengerInfo.allEncStr}#0`
        )
        .join(";") + ";",
  };
};

// 列表中除了当前车次外的其他车次全部加入候补计划
const generatePlansByTrains = (config, trains, targetTrain) => {
  return trains
    .filter((i) => i.secretStr !== targetTrain.secretStr)
    .map((i) => `${i.secretStr},${config.seatType}#`)
    .join("");
};

// web端必须先选一个进行候补订单，默认选择targetTrain
const generateSecretListByTrains = (config, targetTrain) => {
  return targetTrain.secretStr + "#" + config.seatType + "|";
};

module.exports = {
  log,
  getStationCode,
  getStationName,
  delay,
  generateRandomUA,
  updateCookie,
  selectTargetTrain,
  extractTokensFromHtml,
  precisionTimer,
  getPassengerStr,
  generatePlansByTrains,
  generateSecretListByTrains,
};
