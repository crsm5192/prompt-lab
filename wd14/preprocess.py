"""SmilingWolf WD tagger input: white alpha composite, square pad, BGR NHWC."""
import numpy as np
from PIL import Image


def prepare_image(image, target_size=448):
    image = image.convert("RGBA")
    canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
    canvas.alpha_composite(image)
    image = canvas.convert("RGB")
    side = max(image.size)
    padded = Image.new("RGB", (side, side), (255, 255, 255))
    padded.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    if side != target_size:
        padded = padded.resize((target_size, target_size), Image.Resampling.BICUBIC)
    pixels = np.asarray(padded, dtype=np.float32)[:, :, ::-1]
    return np.ascontiguousarray(pixels[None, ...])
