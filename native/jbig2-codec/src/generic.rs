use crate::{
    arith::{Decoder, Encoder},
    Jbig2Error, OwnedBilevel,
};

const CONTEXT_COUNT: usize = 1 << 16;
const TPGD_CONTEXT: usize = 0x9b25;

pub(crate) fn encode(width: u32, height: u32, rows: &[u8], stride: usize) -> Vec<u8> {
    let mut coder = Encoder::new();
    let mut contexts = vec![0; CONTEXT_COUNT];
    let mut ltp = false;

    for y in 0..height as usize {
        let duplicate =
            y > 0 && rows[y * stride..(y + 1) * stride] == rows[(y - 1) * stride..y * stride];
        let sltp = if duplicate { !ltp } else { ltp };
        ltp = duplicate;
        coder.encode(&mut contexts, TPGD_CONTEXT, u8::from(sltp));
        if ltp {
            continue;
        }

        let mut c1 = (u16::from(pixel(rows, stride, width, 0, y, 0, -2)) << 2)
            | (u16::from(pixel(rows, stride, width, 0, y, 1, -2)) << 1)
            | u16::from(pixel(rows, stride, width, 0, y, 2, -2));
        let mut c2 = (u16::from(pixel(rows, stride, width, 0, y, 0, -1)) << 3)
            | (u16::from(pixel(rows, stride, width, 0, y, 1, -1)) << 2)
            | (u16::from(pixel(rows, stride, width, 0, y, 2, -1)) << 1)
            | u16::from(pixel(rows, stride, width, 0, y, 3, -1));
        let mut c3 = 0u16;

        for x in 0..width as usize {
            let context = usize::from((c1 << 11) | (c2 << 4) | c3);
            let bit = pixel(rows, stride, width, x, y, 0, 0);
            coder.encode(&mut contexts, context, bit);
            c1 = ((c1 << 1) | u16::from(pixel(rows, stride, width, x, y, 3, -2))) & 0x1f;
            c2 = ((c2 << 1) | u16::from(pixel(rows, stride, width, x, y, 4, -1))) & 0x7f;
            c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
        }
    }

    coder.finish()
}

pub(crate) fn decode(
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
) -> Result<OwnedBilevel, Jbig2Error> {
    if data.len() < 2 || !data.ends_with(&[0xff, 0xac]) {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    let mut coder = Decoder::new(data).ok_or(Jbig2Error::InvalidArithmeticData)?;
    let mut contexts = vec![0; CONTEXT_COUNT];
    let mut rows = allocate_zeroed(stride, height)?;
    let mut ltp = false;

    for y in 0..height as usize {
        ltp ^= coder.decode(&mut contexts, TPGD_CONTEXT) != 0;
        if ltp {
            if y > 0 {
                let (before, current_and_after) = rows.split_at_mut(y * stride);
                current_and_after[..stride].copy_from_slice(&before[(y - 1) * stride..y * stride]);
            }
            continue;
        }

        let mut c1 = (u16::from(pixel(&rows, stride, width, 0, y, 0, -2)) << 2)
            | (u16::from(pixel(&rows, stride, width, 0, y, 1, -2)) << 1)
            | u16::from(pixel(&rows, stride, width, 0, y, 2, -2));
        let mut c2 = (u16::from(pixel(&rows, stride, width, 0, y, 0, -1)) << 3)
            | (u16::from(pixel(&rows, stride, width, 0, y, 1, -1)) << 2)
            | (u16::from(pixel(&rows, stride, width, 0, y, 2, -1)) << 1)
            | u16::from(pixel(&rows, stride, width, 0, y, 3, -1));
        let mut c3 = 0u16;

        for x in 0..width as usize {
            let context = usize::from((c1 << 11) | (c2 << 4) | c3);
            let bit = coder.decode(&mut contexts, context);
            set_pixel(&mut rows, stride, x, y, bit);
            c1 = ((c1 << 1) | u16::from(pixel(&rows, stride, width, x, y, 3, -2))) & 0x1f;
            c2 = ((c2 << 1) | u16::from(pixel(&rows, stride, width, x, y, 4, -1))) & 0x7f;
            c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
        }
    }

    Ok(OwnedBilevel {
        width,
        height,
        rows,
    })
}

fn allocate_zeroed(stride: usize, height: u32) -> Result<Vec<u8>, Jbig2Error> {
    let length = stride
        .checked_mul(height as usize)
        .ok_or(Jbig2Error::AllocationFailed)?;
    let mut rows = Vec::new();
    rows.try_reserve_exact(length)
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    rows.resize(length, 0);
    Ok(rows)
}

fn pixel(rows: &[u8], stride: usize, width: u32, x: usize, y: usize, dx: isize, dy: isize) -> u8 {
    let Some(target_x) = x.checked_add_signed(dx) else {
        return 0;
    };
    let Some(target_y) = y.checked_add_signed(dy) else {
        return 0;
    };
    if target_x >= width as usize || target_y >= rows.len() / stride {
        return 0;
    }
    rows[target_y * stride + target_x / 8] >> (7 - target_x % 8) & 1
}

fn set_pixel(rows: &mut [u8], stride: usize, x: usize, y: usize, bit: u8) {
    rows[y * stride + x / 8] |= bit << (7 - x % 8);
}
