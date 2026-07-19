use crate::BinaryImage;
use std::collections::VecDeque;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Component {
    pub label: u32,
    pub area: usize,
    pub left: usize,
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
}

#[derive(Clone, Debug)]
pub struct ComponentMap {
    width: usize,
    height: usize,
    labels: Vec<u32>,
    components: Vec<Component>,
}

impl ComponentMap {
    /// Labels black foreground with 8-connectivity.
    pub fn from_binary(image: &BinaryImage) -> Self {
        let mut labels = vec![0u32; image.width().saturating_mul(image.height())];
        let mut components = Vec::new();
        let mut queue = VecDeque::new();
        for y in 0..image.height() {
            for x in 0..image.width() {
                if !image.get(x, y) || labels[y * image.width() + x] != 0 {
                    continue;
                }
                let label = (components.len() + 1) as u32;
                labels[y * image.width() + x] = label;
                queue.push_back((x, y));
                let mut component = Component {
                    label,
                    area: 0,
                    left: x,
                    top: y,
                    right: x,
                    bottom: y,
                };
                while let Some((cx, cy)) = queue.pop_front() {
                    component.area += 1;
                    component.left = component.left.min(cx);
                    component.right = component.right.max(cx);
                    component.top = component.top.min(cy);
                    component.bottom = component.bottom.max(cy);
                    for ny in cy.saturating_sub(1)..=(cy + 1).min(image.height() - 1) {
                        for nx in cx.saturating_sub(1)..=(cx + 1).min(image.width() - 1) {
                            let index = ny * image.width() + nx;
                            if image.get(nx, ny) && labels[index] == 0 {
                                labels[index] = label;
                                queue.push_back((nx, ny));
                            }
                        }
                    }
                }
                components.push(component);
            }
        }
        Self {
            width: image.width(),
            height: image.height(),
            labels,
            components,
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }
    pub fn label_at(&self, x: usize, y: usize) -> u32 {
        self.labels[y * self.width + x]
    }
    pub fn components(&self) -> &[Component] {
        &self.components
    }

    pub fn retain(&self, keep: impl Fn(&Component) -> bool) -> BinaryImage {
        let mut accepted = vec![false; self.components.len() + 1];
        for component in &self.components {
            accepted[component.label as usize] = keep(component);
        }
        let mut image = BinaryImage::new(self.width, self.height);
        for y in 0..self.height {
            for x in 0..self.width {
                let label = self.label_at(x, y) as usize;
                image.set(x, y, label != 0 && accepted[label]);
            }
        }
        image
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_diagonal_pixels_together() {
        let mut image = BinaryImage::new(5, 5);
        image.set(1, 1, true);
        image.set(2, 2, true);
        image.set(4, 4, true);
        let map = ComponentMap::from_binary(&image);
        assert_eq!(map.components().len(), 2);
        assert_eq!(map.components()[0].area, 2);
    }
}
