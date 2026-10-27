declare module 'virtual:my-bad-client' {
  export const getClientScript: () => string
  export const getClientStyles: () => string
  export const getBadgeScript: () => string
}

declare module 'virtual:my-bad-badge-styles' {
  const styles: string
  export default styles
}
