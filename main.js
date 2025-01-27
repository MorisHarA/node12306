const axios = require("axios");
const qs = require("qs");
const {
  getStationCode,
  getStationName,
  delay,
  log,
  generateRandomUA,
  updateCookie,
  selectTargetTrain,
  extractTokensFromHtml,
  precisionTimer,
  getPassengerStr,
  generatePlansByTrains,
  generateSecretListByTrains,
} = require("./utils");

// 配置项（需手动填写）
const config = {
  manualCookie: "_uab_collina=xxxx", // 手动登录后的Cookie
  fromStation: "灌南",
  toStation: "苏州",
  date: "2025-02-07",
  trainNumber: "D2913",
  passenger: ["张三"], // 需提前从接口getPassengerDTOs获取
  seatType: "O", // 座位类型（O=二等座，M=一等座）
  targetTime: "2025-01-24T17:30:00.000+08:00", // 抢票的时间点
  hbImmediately: false, // 是否直接候补
};

// --------------------------
// 核心工具函数：封装带Cookie和Headers的请求
// --------------------------
async function request12306({ method = "get", url, data, customReferer }) {
  const dynamicHeaders = {
    "User-Agent": generateRandomUA(),
    Referer: customReferer || "https://kyfw.12306.cn/otn/leftTicket/init",
    Cookie: config.manualCookie,
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
  };

  log(url);

  const axiosConfig = {
    method,
    url,
    headers: dynamicHeaders,
    timeout: 10000,
  };

  // 处理请求数据
  if (method.toLowerCase() === "get") {
    axiosConfig.params = data;
    axiosConfig.paramsSerializer = (params) =>
      qs.stringify(params, { arrayFormat: "repeat" });
  } else {
    axiosConfig.data = qs.stringify(data);
    axiosConfig.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  try {
    const response = await axios(axiosConfig);
    // ---------------
    // Cookie 自动更新
    // ---------------
    const newCookies = response.headers["set-cookie"];
    if (newCookies) {
      // 合并新旧 Cookie
      config.manualCookie = updateCookie(cookie, newCookies);
      log("Cookie 已更新");
      return response.data;
    }
    return response.data;
  } catch (error) {
    const errorInfo = {
      code: error.response?.status || "NETWORK_ERROR",
      message: error.message,
      url,
      payload: data,
    };

    // 特定错误处理
    if (error.response?.status === 403) {
      console.error("触发风控，建议更换IP或Cookie");
    }

    console.error(`请求失败: ${JSON.stringify(errorInfo)}`);
    return null;
  }
}

// --------------------------
// 验证Cookie有效性
// --------------------------
async function checkUser() {
  try {
    // 调用需要登录态的接口验证Cookie（示例：检查用户登录状态）
    const response = await request12306({
      method: "post",
      url: "https://kyfw.12306.cn/otn/login/checkUser",
      data: { _json_att: "" },
    });

    // 解析关键字段
    const isValid = response?.data?.flag === true; // flag=true表示有效
    log(isValid ? "Cookie有效" : "Cookie已失效");
    return isValid;
  } catch (error) {
    // 网络错误或接口返回异常
    console.error("Cookie验证异常:", error.message);
    return false;
  }
}

// --------------------------
// 查询列表
// --------------------------
async function queryTickets() {
  try {
    const fromCode = getStationCode(config.fromStation);
    const toCode = getStationCode(config.toStation);

    if (!fromCode || !toCode) {
      log("出发站或者终点站没找到");
    }

    const params = {
      "leftTicketDTO.train_date": config.date,
      "leftTicketDTO.from_station": fromCode,
      "leftTicketDTO.to_station": toCode,
      purpose_codes: "ADULT",
    };

    const response = await request12306({
      method: "get",
      url: "https://kyfw.12306.cn/otn/leftTicket/queryG",
      data: params,
    });

    // 解析响应数据结构
    const trains = response?.data?.result || [];
    if (trains.length === 0) throw new Error("未查询到可用车次");

    return trains.map((train) => {
      const fields = train.split("|");
      return {
        secretStr: fields[0], // 加密字符串（下单必需）
        trainNo: fields[2],
        trainNumber: fields[3], // 车次号（如G101）
        fromStation: fields[6], // 出发站电报码
        toStation: fields[7], // 到达站电报码
        startTime: fields[8], // 发车时间（如08:00）
        arriveTime: fields[9], // 到达时间（如12:00）
        seatTypes: {
          // 座位余票状态
          business: fields[32], // 商务座
          first: fields[31], // 一等座
          second: fields[30], // 二等座
        },
        trainLocation: fields[15], // 列车位置码（下单必需）
      };
    });
  } catch (error) {
    console.error("余票查询失败:", error.message);
    return [];
  }
}

// --------------------------
// 提交订单请求（submitOrderRequest）
// --------------------------
async function submitOrderRequest(params) {
  try {
    const postData = {
      secretStr: decodeURIComponent(params.secretStr), // 从余票查询获取
      train_date: params.trainDate, // 格式：YYYY-MM-DD
      back_train_date: params.trainDate, // 返程日期（单程同出发日）
      tour_flag: "dc", // 单程票固定值
      purpose_codes: "ADULT", // 成人票
      query_from_station_name: params.fromStationName,
      query_to_station_name: params.toStationName,
      undefined: "", // 必需的空字段
    };

    const response = await request12306({
      method: "post",
      url: "https://kyfw.12306.cn/otn/leftTicket/submitOrderRequest",
      data: postData,
      customReferer: "https://kyfw.12306.cn/otn/leftTicket/init",
    });

    // 检查关键响应字段
    if (!response || response.status !== true) {
      throw new Error(response?.messages?.join(";") || "订单提交失败");
    }

    return {
      submitStatus: true,
    };
  } catch (error) {
    console.error("订单提交异常:", error.message);
  }
}

// --------------------------
// 初始化下单环境（获取globalRepeatSubmitToken 和 ticketInfoForPassengerForm）
// --------------------------
async function initDc() {
  const data = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/confirmPassenger/initDc",
    data: { _json_att: "" },
    responseType: "text",
  });

  if (!data) throw new Error("initDc失败");

  const result = extractTokensFromHtml(data);

  return result;
}

// --------------------------
// 获取乘客信息
// --------------------------
async function getPassengerDTOs() {
  const data = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/confirmPassenger/getPassengerDTOs",
    data: {
      _json_att: "",
      // REPEAT_SUBMIT_TOKEN: token,
    },
  });

  return data?.data?.normal_passengers || [];
}

// --------------------------
// 验证订单信息
// --------------------------
async function checkOrderInfo(token, passengerTicketStr, oldPassengerStr) {
  const postData = {
    cancel_flag: 2,
    bed_level_order_num: "000000000000000000000000000000",
    passengerTicketStr,
    oldPassengerStr,
    tour_flag: "dc",
    randCode: "",
    whatsSelect: 1,
    scene: "nc_login",
    _json_att: "",
    REPEAT_SUBMIT_TOKEN: token,
  };

  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/confirmPassenger/checkOrderInfo",
    data: postData,
  });

  log(response?.data);

  return response?.data;
}

// --------------------------
// 获取排队状态
// --------------------------
async function getQueueCount(token, targetTrain, ticketInfoForPassengerForm) {
  const postData = {
    train_date: new Date(config.date).toUTCString(),
    train_no: targetTrain.trainNo,
    stationTrainCode: config.trainNumber,
    seatType: config.seatType,
    fromStationTelecode: targetTrain.fromStation,
    toStationTelecode: targetTrain.toStation,
    leftTicket:
      ticketInfoForPassengerForm.queryLeftTicketRequestDTO.ypInfoDetail,
    purpose_codes: "00",
    train_location: ticketInfoForPassengerForm.train_location,
    _json_att: "",
    REPEAT_SUBMIT_TOKEN: token,
  };

  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/confirmPassenger/getQueueCount",
    data: postData,
  });

  log(response.data);

  return response?.data || {};
}

// --------------------------
// 确认排队（需处理余票不足等异常）
// --------------------------
async function confirmQueue(
  token,
  passengerTicketStr,
  oldPassengerStr,
  ticketInfoForPassengerForm
) {
  const params = {
    passengerTicketStr,
    oldPassengerStr,
    purpose_codes: "00",
    key_check_isChange: ticketInfoForPassengerForm.key_check_isChange,
    leftTicketStr: ticketInfoForPassengerForm.leftTicketStr,
    train_location: ticketInfoForPassengerForm.train_location,
    choose_seats: "",
    seatDetailType: "000",
    is_jy: "N",
    is_cj: "Y",
    encryptedData: "",
    whatsSelect: "1",
    roomType: "00",
    dwAll: "N",
    _json_att: "",
    REPEAT_SUBMIT_TOKEN: token,
  };

  const data = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/confirmPassenger/confirmSingleForQueue",
    data: params,
    customReferer: "https://kyfw.12306.cn/otn/confirmPassenger/initDc",
  });
  return data?.data || {};
}

// --------------------------
// 上传12306日志（可能非必须）
// --------------------------
async function basedataLog(type, token) {
  const params = {
    type,
  };
  if (token) {
    params._json_att = "";
    params.REPEAT_SUBMIT_TOKEN = token;
  }
  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/basedata/log",
    data: params,
  });
  log(response);
}

// --------------------------
// 轮询查询订单状态
// --------------------------
async function pollOrderStatus(token) {
  const interval = setInterval(async () => {
    const response = await request12306({
      method: "get",
      url: "https://kyfw.12306.cn/otn/confirmPassenger/queryOrderWaitTime",
      data: {
        random: new Date().getTime(),
        tourFlag: "dc",
        _json_att: "",
        REPEAT_SUBMIT_TOKEN: token,
      },
    });

    if (!response?.data?.queryOrderWaitTimeStatus) {
      clearInterval(interval);
      log("订单已失效");
      return;
    }

    if (response?.data?.orderId) {
      log(`✅ 恭喜下单成功，订单号${response.data.orderId}，请手动完成支付！`);
      clearInterval(interval);
      return;
    }

    log(response.data, "response.data");
  }, 3000); // 每3秒查询一次
}

// --------------------------
// 校验车次有没有资格候补
// --------------------------
async function checkHb(secretList) {
  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/afterNate/chechFace",
    data: {
      secretList,
      _json_att: "",
    },
    customReferer: "https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc",
  });
  log(response, "response");
  return response?.data || {};
}

// --------------------------
// 提交候补订单
// --------------------------
async function submitHbOrderRequest(secretList) {
  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/afterNate/submitOrderRequest",
    data: {
      secretList,
      _json_att: "",
    },
    customReferer: "https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc",
  });
  log(response, "response");
  return response?.data || {};
}

// --------------------------
// 确认候补订单
// --------------------------
async function confirmHB(plans, afterNatePassengerInfo) {
  const parmas = {
    passengerInfo: afterNatePassengerInfo,
    jzParam: "",
    hbTrain: "",
    lkParam: "",
    sessionId: "",
    sig: "",
    scene: "nc_login",
    encryptedData: "",
    if_receive_wseat: "N", // 接受无座
    realize_limit_time_diff: "360", // 截止兑现时间：开车前6小时
    plans, // 车次信息
    tmp_train_date: config.date.replace(/-/g, "") + "#", // 当天新增的列车
    tmp_train_time: "0817#", // 早上8点到下午5点都能接受
    add_train_flag: "Y", //接受新增列车
    add_train_seat_type_code: "",
  };
  const response = await request12306({
    method: "post",
    url: "https://kyfw.12306.cn/otn/afterNate/confirmHB",
    data: parmas,
    customReferer: "https://kyfw.12306.cn/otn/view/lineUp_toPay.html",
  });
  log(response, "confirmHB");
  return response?.data || {};
}

// --------------------------
// 候补队列查询
// --------------------------
async function pollHbQueue() {
  const interval = setInterval(async () => {
    const response = await request12306({
      method: "post",
      url: "https://kyfw.12306.cn/otn/afterNate/queryQueue",
      data: {},
      customReferer: "https://kyfw.12306.cn/otn/view/lineUp_toPay.html",
    });
    log(response, "pollHbQueue");
    if (response?.data.status === 2) {
      log(`候补下单失败`);
      clearInterval(interval);
    }
    if (response.data.reserve_no) {
      log(
        `✅ 候补下单成功，订单号${response.data.reserve_no}，请手动完成支付！`
      );
      clearInterval(interval);
    }
  }, 3000); // 每3秒查询一次
}

// --------------------------
// 候补流程
// --------------------------
async function hbStart(plans, afterNatePassengerInfo, secretList) {
  try {
    // 1.校验候补资格
    const { login_flag, face_flag } = await checkHb(secretList);
    if (!login_flag || !face_flag) {
      log("校验候补资格失败");
      return;
    }

    // 2.提交候补订单
    const { flag } = await submitHbOrderRequest(secretList);
    if (!flag) {
      log("提交候补订单失败");
      return;
    }

    await delay(1000);

    // 3. 提交日志到
    basedataLog("hb");

    // 4.确认候补
    const response = await confirmHB(plans, afterNatePassengerInfo);
    if (!response.flag) {
      return;
    }

    // 5.候补队列查询
    await pollHbQueue();
  } catch (error) {
    console.error("候补流程中断:", error.message);
  }
}

// --------------------------
// 主流程
// --------------------------
(async () => {
  try {
    // 1. 验证Cookie
    const isValid = await checkUser();
    if (!isValid) throw new Error("Cookie无效");

    // 5. 获取乘客信息
    const passengers = await getPassengerDTOs();
    const passenger = passengers.filter((p) =>
      config.passenger.includes(p.passenger_name)
    );
    const { passengerTicketStr, oldPassengerStr, afterNatePassengerInfo } =
      getPassengerStr(config, passenger);
    log({
      passengerTicketStr,
      oldPassengerStr,
      afterNatePassengerInfo,
    });
    if (!passenger?.length) throw new Error("未找到指定乘客");

    await precisionTimer(config.targetTime);
    log("时间到！");

    // 2. 查询车次信息
    const trains = await queryTickets();

    if (trains.length === 0) {
      throw new Error("未查询到可用车次");
    }

    const { targetTrain, processedTrains } = selectTargetTrain(trains, config);

    log(processedTrains);

    log(targetTrain);

    // 拿到plans后，可以进行候补操作
    const plans = generatePlansByTrains(config, trains, targetTrain);

    const secretList = generateSecretListByTrains(config, targetTrain);

    // 如果全是没余票的，直接候补
    if (
      config.hbImmediately ||
      processedTrains.every((i) => i.priority === 1)
    ) {
      hbStart(plans, afterNatePassengerInfo, secretList);
      return;
    }

    // 3. 提交订单
    await submitOrderRequest({
      secretStr: targetTrain.secretStr,
      trainDate: config.date,
      fromStationName: getStationName(targetTrain.fromStation),
      toStationName: getStationName(targetTrain.toStation),
      trainNumber: targetTrain.trainNumber,
    });

    // 4. 初始化下单环境
    const { globalRepeatSubmitToken, ticketInfoForPassengerForm } =
      await initDc();

    // 6. 验证订单
    const { submitStatus } = await checkOrderInfo(
      globalRepeatSubmitToken,
      passengerTicketStr,
      oldPassengerStr
    );
    if (!submitStatus) {
      log("订单验证失败, 准备进入候补队列");
      hbStart(plans, afterNatePassengerInfo, secretList);
      return;
    }

    // 7. 获取排队状态
    const queueData = await getQueueCount(
      globalRepeatSubmitToken,
      targetTrain,
      ticketInfoForPassengerForm
    );

    if (!queueData.op_2) throw new Error("排队失败");

    // 8. 提交日志到12306
    basedataLog("dc", globalRepeatSubmitToken);

    // 9. 确认排队状态
    const confirmResult = await confirmQueue(
      globalRepeatSubmitToken,
      passengerTicketStr,
      oldPassengerStr,
      ticketInfoForPassengerForm
    );

    if (!confirmResult.submitStatus) {
      throw new Error(`出票失败, 原因：${confirmResult.errMsg}`);
    }

    // 10. 轮询订单状态
    await pollOrderStatus(globalRepeatSubmitToken);

    // 11. 手动支付订单
  } catch (error) {
    console.error("流程中断:", error.message);
  }
})();
