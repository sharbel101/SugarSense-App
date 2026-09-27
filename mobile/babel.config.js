module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Required by react-native-reanimated 4.x, whose worklet transform moved into this separate
    // package. Must be listed last in the plugins array (Reanimated's own requirement) - trivially
    // true here since it's the only one. Without this, Reanimated's un-transformed worklet code
    // reaches Hermes's bytecode compiler as-is, which is what was hanging the dev bundle build.
    plugins: ['react-native-worklets/plugin'],
  };
};
