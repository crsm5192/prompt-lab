import unittest
import numpy as np
from PIL import Image
from preprocess import prepare_image


class PreprocessTest(unittest.TestCase):
    def test_rgb_red_is_bgr_red(self):
        pixels = prepare_image(Image.new("RGB", (4, 4), (255, 0, 0)), 4)
        self.assertEqual(pixels.shape, (1, 4, 4, 3))
        self.assertEqual(pixels.dtype, np.float32)
        np.testing.assert_array_equal(pixels[0, 1, 1], [0, 0, 255])

    def test_alpha_is_composited_on_white(self):
        pixels = prepare_image(Image.new("RGBA", (4, 4), (255, 0, 0, 0)), 4)
        np.testing.assert_array_equal(pixels, np.full((1, 4, 4, 3), 255, dtype=np.float32))

    def test_non_square_is_padded_without_stretching(self):
        pixels = prepare_image(Image.new("RGB", (4, 2), (0, 0, 255)), 4)[0]
        np.testing.assert_array_equal(pixels[0], np.full((4, 3), 255))
        np.testing.assert_array_equal(pixels[1, 1], [255, 0, 0])
        np.testing.assert_array_equal(pixels[3], np.full((4, 3), 255))


if __name__ == "__main__":
    unittest.main()
