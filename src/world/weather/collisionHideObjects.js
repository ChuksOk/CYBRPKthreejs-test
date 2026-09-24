export function collectCollisionHideObjects({ rain, smoke, planes, sky, collisionHideExtra } = {}) {
  const hideObjects = [];

  // Runner drones / bolts / fx / pickups / viewmodel (see createRunnerGame).
  if (collisionHideExtra) {
    hideObjects.push(...collisionHideExtra);
  }

  if (rain?.group) {
    hideObjects.push(rain.group);
  }

  if (sky?.mesh) {
    hideObjects.push(sky.mesh);
  }

  if (planes?.group) {
    hideObjects.push(planes.group);
  }

  if (smoke?.emitters) {
    for (const emitter of smoke.emitters) {
      if (emitter?.mesh) {
        hideObjects.push(emitter.mesh);
      }
    }
  }

  return hideObjects;
}
