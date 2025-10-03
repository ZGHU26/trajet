/* global window */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { _MapContext as MapContext, StaticMap, NavigationControl, ScaleControl } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import DeckGL from '@deck.gl/react';
import { useSubscribe, useUnsubscribe } from '@/utils/usePubSub';
import { AmbientLight, LightingEffect, MapView, _SunLight as SunLight } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { NodeIndexOutlined } from '@ant-design/icons';

// 路网 + 仿真
import { segmentsFromGeoJSON, simulateTripsOnRoads } from '../../utils/roadSimLite';
// 红绿灯
import { loadSignalsGeoJSON, buildSignalMapForNodes, isGreenAt } from '../../utils/signal';

// redux
import { useDispatch, useMappedState } from 'redux-react-hook';
import {
  setTripsinfo_tmp,
  setPlay_tmp,
  setMarks_tmp,
  setshowplayinfo_tmp,
  settrajColor1_tmp,
  settrajColor2_tmp,
  settrailLength_tmp,
  settrajwidth_tmp,
  setTimelineval_tmp
} from '@/redux/actions/traj';

import { utctostrtime } from '@/utils/utctostrtime';

const MAPBOX_ACCESS_TOKEN = 'pk.eyJ1IjoibmkxbzEiLCJhIjoiY2t3ZDgzMmR5NDF4czJ1cm84Z3NqOGt3OSJ9.yOYP6pxDzXzhbHfyk3uORg';

export default function Deckmap() {
  const unsubscribe = useUnsubscribe();

  // -------- redux --------
  const mapState = useCallback(state => ({ traj: state.traj }), []);
  const { traj } = useMappedState(mapState);
  const { tripsinfo = {}, play, trajlight_isshow, trajColor1, trajColor2, trailLength, trajwidth } = traj || {};

  const dispatch = useDispatch();
  const setTripsinfo = (data) => dispatch(setTripsinfo_tmp(data));
  const setPlay = (data) => dispatch(setPlay_tmp(data));
  const setMarks = (data) => dispatch(setMarks_tmp(data));
  const setshowplayinfo = (data) => dispatch(setshowplayinfo_tmp(data));
  const settrajColor1 = (data) => dispatch(settrajColor1_tmp(data));
  const settrajColor2 = (data) => dispatch(settrajColor2_tmp(data));
  const settrailLength = (data) => dispatch(settrailLength_tmp(data));
  const settrajwidth = (data) => dispatch(settrajwidth_tmp(data));
  const setTimelineval = (data) => dispatch(setTimelineval_tmp(data));

  // -------- 光照 --------
  const [lightintensity] = useState(2);
  const [lightx] = useState(1554937300);
  const ambientLight = new AmbientLight({ color: [255, 255, 255], intensity: 1.0 });
  const sunLight = new SunLight({
    timestamp: lightx > 1e12 ? lightx : lightx * 1000,
    color: [255, 255, 255],
    intensity: lightintensity
  });
  const lightingEffect = new LightingEffect({ ambientLight, sunLight });
  const theme = { effects: [lightingEffect] };

  // -------- 视角 --------
  const [viewState, setViewState] = useState({
    longitude: 2.5,
    latitude: 49.45,
    zoom: 9,
    pitch: 45,
    bearing: 0
  });
  const [mapStyle, setMapStyle] = useState('dark-v9');
  useSubscribe('mapstyle', (_, data) => setMapStyle(data));

  // -------- 时间动画（秒）--------
  const [animation] = useState({});
  const [time_here, setTime_here] = useState(0);
  const [animationSpeed, setanimationSpeed] = useState(1);
  unsubscribe('animationSpeed');
  useSubscribe('animationSpeed', (_, data) => setanimationSpeed(data || 1));

  const animate = () => {
    setTime_here(t => {
      if (!tripsinfo || !tripsinfo.loopLength) return t;
      setMarks({
        0: utctostrtime(tripsinfo.starttime).slice(0, 20),
        [100 * t / tripsinfo.loopLength]: utctostrtime(tripsinfo.starttime + t * 1000).slice(0, 20),
        100: utctostrtime(tripsinfo.starttime + tripsinfo.loopLength * 1000).slice(0, 20)
      });
      setTimelineval(100 * t / tripsinfo.loopLength);
      return (t + animationSpeed) % tripsinfo.loopLength;
    });
  };
  unsubscribe('playtime');
  useSubscribe('playtime', (_, data) => {
    if (!tripsinfo || !tripsinfo.loopLength) return;
    setTime_here(tripsinfo.loopLength * (data || 0) / 100);
  });
  useEffect(() => {
    if (play) animation.id = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animation.id);
  });

  // -------- 路网 & 信号 --------
  const [roadSegs, setRoadSegs] = useState([]);
  const [signalMap, setSignalMap] = useState(null);
  const [signalPositions, setSignalPositions] = useState([]);
  const [numCars, setNumCars] = useState(1200);
  const [durationSec, setDurationSec] = useState(360);

  // 生成 key 的兜底函数
  const toKey = p => Array.isArray(p) ? `${p[0].toFixed(6)},${p[1].toFixed(6)}` : '';

  // 只加载一次
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // 1) 道路
        const roadsRes = await fetch('/oise-roads.geojson');
        const roadsGj = await roadsRes.json();
        const segs = segmentsFromGeoJSON(roadsGj);
        if (!mounted) return;
        setRoadSegs(segs);

        // 2) 节点列表
        const nodeMap = new Map();
        for (const s of segs) {
          const aKey = s.aKey || toKey(s.a);
          const bKey = s.bKey || toKey(s.b);
          if (aKey && !nodeMap.has(aKey)) nodeMap.set(aKey, { id: aKey, coord: s.a });
          if (bKey && !nodeMap.has(bKey)) nodeMap.set(bKey, { id: bKey, coord: s.b });
        }
        const nodes = Array.from(nodeMap.values());

        // 3) 红绿灯
        let sigMap = null, sigPos = [];
        try {
          const sgj = await loadSignalsGeoJSON('/oise-signals.geojson');
          const built = buildSignalMapForNodes(nodes, sgj, 120); // 120m 更容易命中
          sigMap = built.signalMap;
          sigPos = built.signalPositions;
        } catch {
          console.warn('未找到 oise-signals.geojson，红绿灯为空');
        }
        if (!mounted) return;
        setSignalMap(sigMap);
        setSignalPositions(sigPos);

        // 4) 初始生成
        regenerate(segs, numCars, durationSec, sigMap);
        console.log('路段=', segs.length, '节点=', nodes.length, '匹配信号路口=', sigPos.length, 'signalMap size=', sigMap ? sigMap.size : 0);
      } catch (e) {
        console.error('加载 oise-roads.geojson 失败：', e);
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 生成/重算
  const regenerate = useCallback((segs = roadSegs, carN = numCars, dur = durationSec, sigMapParam = signalMap) => {
    if (!segs || segs.length === 0) return;
    const synth = simulateTripsOnRoads({
      segs,
      numCars: carN,
      durationSec: dur,
      stepSec: 1,
      signalMap: sigMapParam,
      isGreenAt
    });

    setTripsinfo({
      trips: synth.trips || [],
      starttime: synth.starttime, // 秒
      loopLength: synth.loopLength
    });
    setPlay(true);
    setshowplayinfo(true);

    if (synth.trips && synth.trips.length > 0) {
      const [lng, lat] = synth.trips[0].geometry.coordinates[0];
      setViewState(v => ({ ...v, longitude: lng, latitude: lat, zoom: 10 }));
    }
  }, [roadSegs, numCars, durationSec, signalMap, setTripsinfo, setPlay, setshowplayinfo]);

  // 轨迹显隐开关（默认显示）
  const [trajlayer_isshow] = useState(true);

  // -------- 图层 --------
  // 红绿灯位置（20 米半径）
  const signalsLayer = useMemo(() => new ScatterplotLayer({
    id: 'traffic-signals-red-dots',
    data: signalPositions || [],
    getPosition: d => d.coord,
    radiusUnits: 'meters',
    getRadius: () => 20,                  // 20 米半径（更显眼）
    radiusMinPixels: 3,
    getFillColor: [255, 0, 0, 230],
    pickable: false,
    visible: true
  }), [signalPositions]);

  const tripsCore = useMemo(() => new TripsLayer({
    id: 'trips-core',
    data: (tripsinfo && tripsinfo.trips) ? tripsinfo.trips : [],
    getPath: d => d.geometry.coordinates,
    getTimestamps: d => d.properties.timestamp, // 秒
    getColor: (trajColor1 || [66, 135, 245, 255]).slice(0, 3),
    opacity: 0.8,
    widthMinPixels: Math.max(1, trajwidth || 1),
    trailLength: Math.max(10, trailLength || 60),
    currentTime: time_here, // 秒
    shadowEnabled: false,
    visible: true
  }), [tripsinfo, trajColor1, trajwidth, trailLength, time_here]);

  const tripsGlow = useMemo(() => {
    if (!(trajlayer_isshow && trajlight_isshow)) return null;
    return new TripsLayer({
      id: 'trips-glow',
      data: (tripsinfo && tripsinfo.trips) ? tripsinfo.trips : [],
      getPath: d => d.geometry.coordinates,
      getTimestamps: d => d.properties.timestamp,
      getColor: (trajColor2 || [66, 135, 245, 255]).slice(0, 3),
      opacity: 0.15,
      widthMinPixels: 6 * Math.max(1, trajwidth || 1),
      trailLength: Math.max(10, trailLength || 60),
      currentTime: time_here,
      shadowEnabled: false
    });
  }, [tripsinfo, trajlight_isshow, trajColor2, trajwidth, trailLength, time_here, trajlayer_isshow]);

  const layers = useMemo(() => [tripsCore, tripsGlow, signalsLayer].filter(Boolean), [tripsCore, tripsGlow, signalsLayer]);

  // -------- 控件 --------
  const Controls = (
    <div className="mapboxgl-ctrl mapboxgl-ctrl-group" style={{ display: 'flex', gap: 8, padding: 8 }}>
      <label style={{ padding: '4px 6px' }}>
        车辆:
        <input
          type="number"
          value={numCars}
          onChange={e => setNumCars(Math.max(10, parseInt(e.target.value || '0', 10)))}
          style={{ width: 90, marginLeft: 6 }}
        />
      </label>
      <label style={{ padding: '4px 6px' }}>
        时长(s):
        <input
          type="number"
          value={durationSec}
          onChange={e => setDurationSec(Math.max(30, parseInt(e.target.value || '0', 10)))}
          style={{ width: 90, marginLeft: 6 }}
        />
      </label>
      <button onClick={() => regenerate()} style={{ padding: '0 10px' }}>生成</button>
    </div>
  );

  return (
    <DeckGL
      layers={layers}
      initialViewState={viewState}
      effects={theme.effects}
      controller={{ doubleClickZoom: false, inertia: true, touchRotate: true }}
      style={{ zIndex: 0 }}
      ContextProvider={MapContext.Provider}
    >
      <MapView id="baseMap" controller={true} height="100%">
        <StaticMap
          reuseMaps
          // 你的 react-map-gl 若提示属性名变更，再把下一行替换为 mapboxAccessToken
          mapboxApiAccessToken={MAPBOX_ACCESS_TOKEN}
          mapStyle={`mapbox://styles/mapbox/${mapStyle}`}
          preventStyleDiffing={true}
        >
          <div className='mapboxgl-ctrl-bottom-left' style={{ bottom: '20px' }}>
            <ScaleControl maxWidth={100} unit="metric" />
            {Controls}
          </div>
        </StaticMap>

        <div className='mapboxgl-ctrl-bottom-right' style={{ bottom: '80px' }}>
          <NavigationControl onViewportChange={viewport => setViewState(viewport)} />
          <div className="mapboxgl-ctrl-group mapboxgl-ctrl">
            <button title="trajcontrol" onClick={() => {}} style={{ opacity: 1 }}>
              <NodeIndexOutlined />
            </button>
          </div>
        </div>
      </MapView>
    </DeckGL>
  );
}
