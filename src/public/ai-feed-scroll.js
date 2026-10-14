export function shouldFollowAiFeedAfterScroll({ previousScrollTop, scrollTop, nearBottom, shouldFollow }) {
  if (scrollTop < previousScrollTop) return false;
  if (scrollTop > previousScrollTop && nearBottom) return true;
  return shouldFollow ?? nearBottom;
}
