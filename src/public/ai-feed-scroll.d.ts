export function shouldFollowAiFeedAfterScroll(input: {
  previousScrollTop: number;
  scrollTop: number;
  nearBottom: boolean;
  shouldFollow?: boolean;
}): boolean;
