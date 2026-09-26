// Remotion's bundler resolves imported images to URLs.
declare module '*.png' {
  const src: string;
  export default src;
}
