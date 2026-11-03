import * as THREE from 'three';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from './vendor/jsm/controls/OrbitControls.js';

const loader = new GLTFLoader();
const cache = new Map();

function load(url) {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url).then((gltf) => gltf.scene));
  return cache.get(url);
}

function dress(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8578, 1.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xfff0dc, 0.7);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
}

function frameCamera(camera, object, controls) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.001);
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
  const direction = new THREE.Vector3(0.75, 0.5, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = distance / 200;
  camera.far = distance * 20;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.minDistance = distance * 0.04; // right in on the small details
    controls.maxDistance = distance * 4;
    controls.update();
  }
}

let shared;
const thumbnails = new Map();
// One render per model, however many times it's shown.
export function thumbnail(url) {
  if (!thumbnails.has(url)) thumbnails.set(url, renderThumbnail(url));
  return thumbnails.get(url);
}

async function renderThumbnail(url) {
  const model = await load(url);
  shared ??= new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  shared.setPixelRatio(2);
  shared.setSize(420, 315, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9d5cc);
  dress(scene);
  const copy = model.clone(true);
  scene.add(copy);
  const camera = new THREE.PerspectiveCamera(32, 420 / 315);
  frameCamera(camera, copy);
  shared.render(scene, camera);
  return shared.domElement.toDataURL('image/jpeg', 0.9);
}

// A live view you can turn and zoom. Returns a function that stops it.
export async function mount(container, url) {
  // Keeps the last frame readable, so the view can be frozen to draw on.
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9d5cc);
  dress(scene);
  const model = await load(url);
  const copy = model.clone(true);
  scene.add(copy);
  const camera = new THREE.PerspectiveCamera(32, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  frameCamera(camera, copy, controls);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let running = true;
  const tick = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();
  return () => {
    running = false;
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
