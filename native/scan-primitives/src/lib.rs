//! Deterministic image and geometry primitives for scanned-page cleanup.

pub mod binary;
pub mod components;
pub mod distance;
pub mod geometry;
pub mod gray;
pub mod morphology;
pub mod threshold;

pub use binary::BinaryImage;
pub use components::{Component, ComponentMap};
pub use geometry::{Affine, Line, Point, Polygon, Projective, Rect};
pub use gray::{GrayImage, GrayView};
