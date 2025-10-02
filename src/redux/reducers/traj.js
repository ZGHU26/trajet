const initState = {
  tripsinfo: {
    trips: [],        // 轨迹
    loopLength: 86400, // 循环时长（秒）
    starttime: 0      // 开始时间（秒）
  },
  play: false,

  // 🔵 新增
  simulate: false,
  numCars: 2000,

  time: 0,
  marks: { 0: 'start', 100: 'end' },
  showplayinfo: false,
  animationSpeed: 5,
  trajColor1: [255, 255, 0, 1],
  trajColor2: [253, 0, 0, 1],
  trailLength: 80,
  trajwidth: 1.5,
  timelineval: 20,
  trajlight_isshow: false
};

export default function trajReducer(preState = initState, action) {
  const { type, data } = action;
  switch (type) {
    case 'setTripsinfo':     return { ...preState, tripsinfo: data };
    case 'setPlay':          return { ...preState, play: data };
    case 'setTime':          return { ...preState, time: data };
    case 'setMarks':         return { ...preState, marks: data };
    case 'setshowplayinfo':  return { ...preState, showplayinfo: data };
    case 'setanimationSpeed':return { ...preState, animationSpeed: data };
    case 'settrajColor1':    return { ...preState, trajColor1: data };
    case 'settrajColor2':    return { ...preState, trajColor2: data };
    case 'settrailLength':   return { ...preState, trailLength: data };
    case 'settrajwidth':     return { ...preState, trajwidth: data };
    case 'setTimelineval':   return { ...preState, timelineval: data };
    case 'settrajlight':     return { ...preState, trajlight_isshow: data };

    // 🔵 新增
    case 'setSimulate':      return { ...preState, simulate: data };
    case 'setNumCars':       return { ...preState, numCars: data };

    default:
      return preState;
  }
}
