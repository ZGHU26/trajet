/* global window */
import React, { useState, useEffect, useCallback } from 'react';
import { _MapContext as MapContext, StaticMap, NavigationControl, ScaleControl, FlyToInterpolator } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import DeckGL from '@deck.gl/react';
import { useSubscribe, usePublish, useUnsubscribe } from '@/utils/usePubSub';
import { useInterval } from 'ahooks';
import { AmbientLight, LightingEffect, MapView, FirstPersonView, _SunLight as SunLight } from '@deck.gl/core';
import { BitmapLayer, IconLayer } from '@deck.gl/layers';
import { TileLayer, TripsLayer } from '@deck.gl/geo-layers';
import { NodeIndexOutlined } from '@ant-design/icons';

// 贴路工具
import { segmentsFromGeoJSON, simulateTripsOnRoads } from '../../utils/roadSimLite';

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
  const [ismount, setismount] = useState(false);
  useEffect(() => { setismount(true); }, []);

  // -------- redux 取值 --------
  const mapState = useCallback(state => ({ traj: state.traj }), []);
  const { traj } = useMappedState(mapState);
  const { tripsinfo, play, trajlight_isshow, trajColor1, trajColor2, trailLength, trajwidth } = traj;

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

  // -------- 底图/光照 --------
  const [lightintensity, setlightintensity] = useState(2);
  unsubscribe('lightintensity');
  useSubscribe('lightintensity', (_, data) => setlightintensity(data));

  const [lightx, setlightx] = useState(1554937300); // 秒
  unsubscribe('lightx');
  useSubscribe('lightx', (_, data) => setlightx(data));

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

  useEffect(() => {
    const el = document.getElementById('deckgl-wrapper');
    if (!el) return;
    const handler = (evt) => evt.preventDefault();
    el.addEventListener('contextmenu', handler);
    return () => el.removeEventListener('contextmenu', handler);
  }, []);

  // -------- 旋转控件 --------
  function rotate(pitch, bearing, duration) {
    setViewState(v => ({
      ...v,
      pitch, bearing,
      transitionDuration: duration,
      transitionInterpolator: new FlyToInterpolator()
    }));
  }
  const [angle, setangle] = useState(120);
  const [interval, setInterval] = useState(undefined);
  useInterval(() => {
    rotate(viewState.pitch, angle, 2000);
    setangle(a => a + 30);
  }, interval, { immediate: true });

  function rotatecam() {
    setangle(viewState.bearing + 30);
    if (interval !== 2000) setInterval(2000);
    else { setInterval(undefined); setViewState(viewState); }
  }

  // -------- 时间动画（秒）--------
  const [animation] = useState({});
  const [time_here, setTime_here] = useState(0);
  const [animationSpeed, setanimationSpeed] = useState(1);
  unsubscribe('animationSpeed');
  useSubscribe('animationSpeed', (_, data) => setanimationSpeed(data));

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
    setTime_here(tripsinfo.loopLength * data / 100);
  });

  useEffect(() => {
    if (play) animation.id = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animation.id);
  });

  // -------- 路网 & 贴路生成 --------
  const [roadSegs, setRoadSegs] = useState([]);
  const [numCars, setNumCars] = useState(1200); // 可随时改
  const [durationSec, setDurationSec] = useState(360);

  // 只加载一次 GeoJSON
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/oise-roads.geojson');
        const gj = await res.json();
        const segs = segmentsFromGeoJSON(gj);
        if (!mounted) return;
        console.log('road segments =', segs.length);
        setRoadSegs(segs);
        // 初次生成
        regenerate(segs, numCars, durationSec);
      } catch (e) {
        console.error('加载 oise-roads.geojson 失败：', e);
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 生成/重算
  const regenerate = useCallback((segs = roadSegs, carN = numCars, dur = durationSec) => {
    if (!segs || segs.length === 0) return;
    const synth = simulateTripsOnRoads({
      segs,
      numCars: carN,
      durationSec: dur,
      stepSec: 1
    });

    // 打点自检
    const f = synth.trips?.[0];
    if (f) {
      console.log('coords len =', f.geometry.coordinates.length,
                  'timestamps len =', f.properties.timestamp.length,
                  'loopLength =', synth.loopLength);
    }

    setTripsinfo({
      trips: synth.trips,
      starttime: synth.starttime, // 秒
      loopLength: synth.loopLength
    });
    setPlay(true);
    setshowplayinfo(true);

    if (synth.trips.length > 0) {
      const [lng, lat] = synth.trips[0].geometry.coordinates[0];
      setViewState(v => ({ ...v, longitude: lng, latitude: lat, zoom: 10 }));
    }
  }, [roadSegs, numCars, durationSec, setTripsinfo, setPlay, setshowplayinfo]);

  // -------- 图层 --------
  const [trajlayer_isshow, settrajlayer_isshow] = useState(true);

  const layerTools = (
    <div className="mapboxgl-ctrl-group mapboxgl-ctrl">
      <button title="trajcontrol" onClick={() => settrajlayer_isshow(s => !s)} style={{ opacity: trajlayer_isshow ? 1 : 0.2 }}>
        <NodeIndexOutlined />
      </button>
    </div>
  );

  const layers = [
    new TripsLayer({
      id: 'trips-core',
      data: tripsinfo.trips,
      getPath: d => d.geometry.coordinates,
      getTimestamps: d => d.properties.timestamp, // 秒
      getColor: trajColor1.slice(0, 3),
      opacity: 0.8,
      widthMinPixels: Math.max(1, trajwidth || 1),
      trailLength: Math.max(10, trailLength || 60),
      currentTime: time_here,                    // 秒
      shadowEnabled: false,
      visible: trajlayer_isshow
    }),
    trajlayer_isshow && trajlight_isshow ? new TripsLayer({
      id: 'trips-glow',
      data: tripsinfo.trips,
      getPath: d => d.geometry.coordinates,
      getTimestamps: d => d.properties.timestamp,
      getColor: trajColor2.slice(0, 3),
      opacity: 0.15,
      widthMinPixels: 6 * Math.max(1, trajwidth || 1),
      trailLength: Math.max(10, trailLength || 60),
      currentTime: time_here,
      shadowEnabled: false
    }) : null
  ].filter(Boolean);

  // -------- 渲染 --------
  const minimapBackgroundStyle = {
    position: 'absolute', zIndex: -1, width: '100%', height: '100%',
    background: '#aaa', boxShadow: '0 0 8px 2px rgba(0,0,0,0.15)'
  };

  const onViewStateChange = (evt) => {
    const { viewId, viewState: vs } = evt;
    if (viewId === 'firstPerson') {
      setViewState(v => ({ ...v, longitude: vs.longitude, latitude: vs.latitude, bearing: vs.bearing }));
    } else if (viewId === 'baseMap') {
      setViewState(v => ({
        ...v,
        longitude: vs.longitude,
        latitude: vs.latitude,
        pitch: vs.pitch,
        bearing: vs.bearing,
        zoom: vs.zoom
      }));
    }
  };

  // 顶部右侧：车辆数量/时长 控件
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
      initialViewState={{
        baseMap: viewState,
        firstPerson: { ...viewState, pitch: 0, zoom: 0, position: [0, 0, 2], transitionDuration: undefined, transitionInterpolator: undefined }
      }}
      effects={theme.effects}
      controller={{ doubleClickZoom: false, inertia: true, touchRotate: true }}
      style={{ zIndex: 0 }}
      ContextProvider={MapContext.Provider}
      onViewStateChange={onViewStateChange}
    >
      <MapView id="baseMap" controller={true} y="0%" height="100%" position={[0, 0, 0]}>
        <StaticMap
          reuseMaps
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
         
          {layerTools}
        
        </div>
      </MapView>

      {/* <FirstPersonView
        id="firstPerson"
        controller={{ scrollZoom: false, dragRotate: true, inertia: true }}
        far={10000}
        focalDistance={1.5}
        x={'68%'}
        y={20}
        width={'30%'}
        height={'50%'}
        clear={true}
      >
        <div style={minimapBackgroundStyle} />
      </FirstPersonView> */}
    </DeckGL>
  );
}
